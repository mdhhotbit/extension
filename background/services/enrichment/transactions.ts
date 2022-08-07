import {
  AnyEVMBlock,
  AnyEVMTransaction,
  EIP1559TransactionRequest,
  EVMLog,
  EVMNetwork,
} from "../../networks"
import {
  SmartContractFungibleAsset,
  isSmartContractFungibleAsset,
} from "../../assets"
import { enrichAssetAmountWithDecimalValues } from "../../redux-slices/utils/asset-utils"

import { normalizeEVMAddress, sameEVMAddress } from "../../lib/utils"

import ChainService from "../chain"
import IndexingService from "../indexing"
import NameService from "../name"
import { TransactionAnnotation } from "./types"
import {
  getDistinctRecipentAddressesFromERC20Logs,
  getERC20LogsForAddresses,
} from "./utils"
import { parseLogsForWrappedDepositsAndWithdrawals } from "../../lib/wrappedAsset"
import { parseERC20Tx, parseLogsForERC20Transfers } from "../../lib/erc20"
import { isDefined, isFulfilledPromise } from "../../lib/utils/type-guards"

async function annotationsFromLogs(
  chainService: ChainService,
  indexingService: IndexingService,
  nameService: NameService,
  logs: EVMLog[],
  network: EVMNetwork,
  desiredDecimals: number,
  resolvedTime: number,
  block: AnyEVMBlock | undefined
): Promise<TransactionAnnotation[]> {
  const assets = await indexingService.getCachedAssets(network)

  const accountAddresses = (await chainService.getAccountsToTrack()).map(
    (account) => account.address
  )

  const tokenTransferLogs = [
    ...parseLogsForERC20Transfers(logs),
    ...parseLogsForWrappedDepositsAndWithdrawals(logs),
  ]

  const relevantTransferLogs = getERC20LogsForAddresses(
    tokenTransferLogs,
    accountAddresses
  )
  // Look up transfer log names, then flatten to an address -> name map.
  const namesByAddress = Object.fromEntries(
    (
      await Promise.allSettled(
        getDistinctRecipentAddressesFromERC20Logs(relevantTransferLogs).map(
          async (address) =>
            [
              normalizeEVMAddress(address),
              (await nameService.lookUpName({ address, network }))?.name,
            ] as const
        )
      )
    )
      .filter(isFulfilledPromise)
      .map(({ value }) => value)
      .filter(([, name]) => isDefined(name))
  )

  const subannotations = tokenTransferLogs.flatMap<TransactionAnnotation>(
    ({ contractAddress, amount, senderAddress, recipientAddress }) => {
      // See if the address matches a fungible asset.
      const matchingFungibleAsset = assets.find(
        (asset): asset is SmartContractFungibleAsset =>
          isSmartContractFungibleAsset(asset) &&
          sameEVMAddress(asset.contractAddress, contractAddress)
      )

      if (!matchingFungibleAsset) {
        return []
      }

      // Try to find a resolved name for the recipient; we should probably
      // do this for the sender as well, but one thing at a time.
      const recipientName =
        namesByAddress[normalizeEVMAddress(recipientAddress)]

      return [
        {
          type: "asset-transfer",
          assetAmount: enrichAssetAmountWithDecimalValues(
            {
              asset: matchingFungibleAsset,
              amount,
            },
            desiredDecimals
          ),
          senderAddress,
          recipientAddress,
          recipientName,
          timestamp: resolvedTime,
          blockTimestamp: block?.timestamp,
        },
      ]
    }
  )

  return subannotations
}

/**
 * Resolve an annotation for a partial transaction request, or a pending
 * or mined transaction.
 */
export default async function resolveTransactionAnnotation(
  chainService: ChainService,
  indexingService: IndexingService,
  nameService: NameService,
  network: EVMNetwork,
  transaction:
    | AnyEVMTransaction
    | (Partial<EIP1559TransactionRequest> & {
        from: string
        blockHash?: string
      }),
  desiredDecimals: number
): Promise<TransactionAnnotation> {
  // By default, annotate all requests as contract interactions
  let txAnnotation: TransactionAnnotation = {
    blockTimestamp: undefined,
    timestamp: Date.now(),
    type: "contract-interaction",
  }

  let block: AnyEVMBlock | undefined

  const { gasLimit, maxFeePerGas, maxPriorityFeePerGas, blockHash } =
    transaction

  // If this is a transaction request...
  if (gasLimit && maxFeePerGas && maxPriorityFeePerGas) {
    const gasFee = gasLimit * maxFeePerGas
    const {
      assetAmount: { amount: baseAssetBalance },
    } = await chainService.getLatestBaseAccountBalance({
      address: transaction.from,
      network,
    })
    // ... and if the wallet doesn't have enough base asset to cover gas,
    // push a warning
    if (gasFee + (transaction.value ?? 0n) > baseAssetBalance) {
      txAnnotation.warnings ??= []
      txAnnotation.warnings.push("insufficient-funds")
    }
  }

  // If the transaction has been mined, get the block and set the timestamp
  if (blockHash) {
    block = await chainService.getBlockData(network, blockHash)
    txAnnotation = {
      ...txAnnotation,
      blockTimestamp: block?.timestamp,
    }
  }

  // If the tx is missing a recipient, its a contract deployment.
  if (typeof transaction.to === "undefined") {
    txAnnotation = {
      ...txAnnotation,
      type: "contract-deployment",
    }
  } else if (
    transaction.input === null ||
    transaction.input === "0x" ||
    typeof transaction.input === "undefined"
  ) {
    // If the tx has no data, it's either a simple ETH send, or it's relying
    // on a contract that's `payable` to execute code

    const { name: toName } = (await nameService.lookUpName({
      address: transaction.to,
      network,
    })) ?? { name: undefined }

    // This is _almost certainly_ not a contract interaction, move on. Note that
    // a simple ETH send to a contract address can still effectively be a
    // contract interaction (because it calls the fallback function on the
    // contract), but for now we deliberately ignore that scenario when
    // categorizing activities.
    // TODO We can do more here by checking how much gas was spent. Anything
    // over the 21k required to send ETH is a more complex contract interaction
    if (typeof transaction.value !== "undefined") {
      txAnnotation = {
        ...txAnnotation,
        type: "asset-transfer",
        senderAddress: transaction.from,
        recipientName: toName,
        recipientAddress: transaction.to,
        assetAmount: enrichAssetAmountWithDecimalValues(
          {
            asset: network.baseAsset,
            amount: transaction.value,
          },
          desiredDecimals
        ),
      }
    } else {
      // Fall back on a standard contract interaction.
      txAnnotation = {
        ...txAnnotation,
        contractName: toName,
      }
    }
  } else {
    const assets = await indexingService.getCachedAssets(network)

    // See if the address matches a fungible asset.
    const matchingFungibleAsset = assets.find(
      (asset): asset is SmartContractFungibleAsset =>
        isSmartContractFungibleAsset(asset) &&
        sameEVMAddress(asset.contractAddress, transaction.to)
    )

    const transactionLogoURL = matchingFungibleAsset?.metadata?.logoURL

    const erc20Tx = parseERC20Tx(transaction.input)

    // TODO handle the case where we don't have asset metadata already
    if (
      matchingFungibleAsset &&
      erc20Tx &&
      (erc20Tx.name === "transfer" || erc20Tx.name === "transferFrom")
    ) {
      const { name: toName } = (await nameService.lookUpName({
        address: erc20Tx.args.to,
        network,
      })) ?? { name: undefined }

      // We have an ERC-20 transfer
      txAnnotation = {
        ...txAnnotation,
        type: "asset-transfer",
        transactionLogoURL,
        senderAddress: erc20Tx.args.from ?? transaction.from,
        recipientAddress: erc20Tx.args.to,
        recipientName: toName,
        assetAmount: enrichAssetAmountWithDecimalValues(
          {
            asset: matchingFungibleAsset,
            amount: BigInt(erc20Tx.args.amount),
          },
          desiredDecimals
        ),
      }
      // Warn if we're sending the token to its own contract
      if (sameEVMAddress(erc20Tx.args.to, transaction.to)) {
        txAnnotation.warnings = ["send-to-token"]
      }
    } else if (matchingFungibleAsset && erc20Tx && erc20Tx.name === "approve") {
      const { name: spenderName } = (await nameService.lookUpName({
        address: erc20Tx.args.spender,
        network,
      })) ?? { name: undefined }

      txAnnotation = {
        ...txAnnotation,
        type: "asset-approval",
        transactionLogoURL,
        spenderAddress: erc20Tx.args.spender,
        spenderName,
        assetAmount: enrichAssetAmountWithDecimalValues(
          {
            asset: matchingFungibleAsset,
            amount: BigInt(erc20Tx.args.value),
          },
          desiredDecimals
        ),
      }
    } else {
      const { name: toName } = (await nameService.lookUpName({
        address: transaction.to,
        network,
      })) ?? { name: undefined }

      // Fall back on a standard contract interaction.
      txAnnotation = {
        ...txAnnotation,
        type: "contract-interaction",
        // Include the logo URL if we resolve it even if the interaction is
        // non-specific; the UI can choose to use it or not, but if we know the
        // address has an associated logo it's worth passing on.
        transactionLogoURL,
        contractName: toName,
      }
    }
  }

  // Look up logs and resolve subannotations, if available.
  if ("logs" in transaction && typeof transaction.logs !== "undefined") {
    const subannotations = await annotationsFromLogs(
      chainService,
      indexingService,
      nameService,
      transaction.logs,
      network,
      desiredDecimals,
      txAnnotation.timestamp,
      block
    )

    if (subannotations.length > 0) {
      txAnnotation.subannotations = subannotations
    }
  }

  return txAnnotation
}
