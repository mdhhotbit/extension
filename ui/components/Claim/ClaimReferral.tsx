import React, { ReactElement } from "react"
import ClaimAmountBanner from "./ClaimAmountBanner"

function DAOButton(props: {
  address: string
  name: string
  logoAsset: string
}) {
  const { address, name, logoAsset } = props
  return (
    <button type="button" className="option">
      <div className="icon" />
      <div className="name">{name}</div>
      <div className="radio" />
      <style jsx>{`
        .option {
          width: 168px;
          height: 136px;
          border-radius: 8px;
          background-color: var(--green-95);
          margin-bottom: 16px;
          display: flex;
          justify-content: center;
          align-items: center;
          flex-direction: column;
        }
        .icon {
          width: 48px;
          height: 48px;
          background-color: #006ae3;
          border-radius: 200px;
          margin-bottom: 8px;
        }
        .radio {
          width: 16px;
          height: 16px;
          border: 2px solid var(--green-60);
          border-radius: 200px;
          margin-top: 8px;
        }
        .option:hover {
          background-color: var(--green-80);
        }
      `}</style>
    </button>
  )
}

export default function ClaimReferral(props: {
  DAOs: any[]
  claimAmount: number
}): ReactElement {
  const { DAOs, claimAmount } = props

  return (
    <div className="claim standard_width">
      <ClaimAmountBanner />
      <ClaimAmountBanner amount={claimAmount} />
      <div className="title">
        Get a bonus of <div className="highlight">463</div> TALLY!
        Get a bonus of
        <div className="highlight">{Math.floor(claimAmount * 0.05)}</div> TALLY!
      </div>
      <div className="description">
        Select a Project/DAO to share the bonus with! You each receive 463
        TALLY!
      </div>
      <div className="options">
        {DAOs.map(({ address, name, logoAsset }) => {
          return (
            <DAOButton address={address} name={name} logoAsset={logoAsset} />
          )
        })}
      </div>
      <style jsx>
        {`
          .claim {
            display: flex;
            flex-flow: column;
            flex-grow: 1;
          }
          .title {
            height: 32px;
            color: #fff;
            font-size: 22px;
            font-weight: 500;
            line-height: 32px;
            display: flex;
            align-items: center;
            margin-top: 25px;
            margin-bottom: 11px;
          }
          .description {
            font-size: 16px;
            line-height: 24px;
            color: var(--green-40);
            margin-bottom: 30px;
          }
          .options {
            display: flex;
            flex-wrap: wrap;
            justify-content: space-between;
          }
          .highlight {
            color: var(--success);
            font-size: 36px;
            font-weight: 500;
            line-height: 42px;
            font-family: Quincy CF;
            margin: 0px 8px;
          }
        `}
      </style>
    </div>
  )
}
