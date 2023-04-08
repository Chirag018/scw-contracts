// Note: playbook.txt
// 1. In separate terminal: npx hardhat node --fork https://polygon-mainnet.g.alchemy.com/v2/-GQeAi0Wvgr8rEoUTlniKPe23Xmeqmsv
// 2. npx hardhat run --network localhost scripts/fork-transactions/deployAccount.ts

import { ethers } from "hardhat";
import { expect } from "chai";

// const options = { gasLimit: 7000000, gasPrice: 70000000000 };

// TODO
// source from config: real protocol contract deployed addresses, token addresses, available modules

// should come from env
const walletFactoryAddress = "0x9eFE4ECe49221225db2Ef214be171578c39f13a4";
// const implementationAddress = "";
const ownerAddress = "0x8c2a86E058228401D40d04b4D4Bf4f9B239d547f";
const accountToImpersonate = "0x8c2a86E058228401D40d04b4D4Bf4f9B239d547f";
const isImpersonated = false;

async function main() {
  const provider = ethers.provider;
  const indexForSalt = 1;

  const [signerAccount] = isImpersonated
    ? [await ethers.getImpersonatedSigner(accountToImpersonate)]
    : await ethers.getSigners();

  const accountFactory = await ethers.getContractAt(
    "contracts/smart-contract-wallet/SmartAccountFactory.sol:SmartAccountFactory",
    walletFactoryAddress
  );

  const expected = await accountFactory.getAddressForCounterFactualAccount(
    ownerAddress,
    indexForSalt
  );
  console.log("deploying new wallet..expected address: ", expected);

  await expect(
    accountFactory.deployCounterFactualAccount(ownerAddress, indexForSalt)
  )
    .to.emit(accountFactory, "AccountCreation")
    .withArgs(expected, ownerAddress, indexForSalt);

  // Can send funds and then imperonate the owner to pull tokens
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
