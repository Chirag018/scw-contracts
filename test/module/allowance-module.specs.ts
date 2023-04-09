import { expect } from "chai";
import { ethers } from "hardhat";
import {
  SmartAccount,
  SmartAccountFactory,
  EntryPoint,
  SocialRecoveryModule,
  WhitelistModule,
  EntryPoint__factory,
  VerifyingSingletonPaymaster,
  VerifyingSingletonPaymaster__factory,
  MockToken,
  MultiSend,
  StorageSetter,
  DefaultCallbackHandler,
  AllowanceModule,
} from "../../typechain";
import {
  SafeTransaction,
  Transaction,
  FeeRefund,
  safeSignTypedData,
  buildSafeTransaction,
  executeContractCallWithSigners,
  EOA_CONTROLLED_FLOW,
} from "../../src/utils/execution";
import {
  arrayify,
  hexConcat,
  parseEther,
  arrayify,
  hexConcat,
  parseEther,
} from "ethers/lib/utils";
import { fillAndSign, fillUserOp } from "../utils/userOp";
import { BigNumber, Signer, utils } from "ethers";
import { UserOperation } from "../utils/userOpetation";

export const EIP712_ALLOWANCE_TRANSFER_TYPE = {
  // "AllowanceTransfer(address safe,address token,uint96 amount,address paymentToken,uint96 payment,uint16 nonce)"
  AccountTx: [
    { type: "address", name: "safe" },
    { type: "address", name: "token" },
    { type: "uint96", name: "amount" },
    { type: "address", name: "paymentToken" },
    { type: "uint96", name: "payment" },
    { type: "uint16", name: "nonce" },
  ],
};

export async function deployEntryPoint(
  provider = ethers.provider
): Promise<EntryPoint> {
  const epf = await (await ethers.getContractFactory("EntryPoint")).deploy();
  return EntryPoint__factory.connect(epf.address, provider.getSigner());
}

export const AddressZero = "0x0000000000000000000000000000000000000000";
export const AddressOne = "0x0000000000000000000000000000000000000001";

function currentMinutes() {
  return Math.floor(Date.now() / (1000 * 60));
}

function wait(ms: any) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function calculateResetTime(baseTime: number, resetTime: number) {
  const cM = currentMinutes();
  return cM - ((cM - baseTime) % resetTime);
}

async function getUserOpWithPaymasterData(
  paymaster: VerifyingSingletonPaymaster,
  smartAccountAddress: any,
  userOp: UserOperation,
  offchainPaymasterSigner: Signer,
  paymasterAddress: string,
  walletOwner: Signer,
  entryPoint: EntryPoint
) {
  const nonceFromContract = await paymaster["getSenderPaymasterNonce(address)"](
    smartAccountAddress
  );

  const hash = await paymaster.getHash(
    userOp,
    nonceFromContract.toNumber(),
    await offchainPaymasterSigner.getAddress()
  );
  const sig = await offchainPaymasterSigner.signMessage(arrayify(hash));
  const userOpWithPaymasterData = await fillAndSign(
    {
      // eslint-disable-next-line node/no-unsupported-features/es-syntax
      ...userOp,
      paymasterAndData: hexConcat([
        paymasterAddress,
        ethers.utils.defaultAbiCoder.encode(
          ["address", "bytes"],
          [await offchainPaymasterSigner.getAddress(), sig]
        ),
      ]),
    },
    walletOwner,
    entryPoint
  );
  return userOpWithPaymasterData;
}

describe("Module transactions via AA flow", function () {
  let entryPoint: EntryPoint;
  let walletOwner: Signer;
  let paymasterAddress: string;
  let offchainSigner: Signer, deployer: Signer;
  let verifyingSingletonPaymaster: VerifyingSingletonPaymaster;
  let baseImpl: SmartAccount;
  let allowanceModule: AllowanceModule;
  let socialRecoveryModule: SocialRecoveryModule;
  let walletFactory: SmartAccountFactory;
  let token: MockToken;
  let multiSend: MultiSend;
  let storage: StorageSetter;
  let owner: string;
  let bob: string;
  let charlie: string;
  let userSCW: any;
  let accounts: any;
  let tx: any;

  before(async () => {
    accounts = await ethers.getSigners();
    entryPoint = await deployEntryPoint();

    deployer = accounts[0];
    offchainSigner = accounts[1];
    walletOwner = deployer;

    owner = await accounts[0].getAddress();
    console.log("address owner ", owner);
    bob = await accounts[1].getAddress();
    console.log("address bob ", bob);
    charlie = await accounts[2].getAddress();
    console.log("address charlie ", charlie);

    const offchainSignerAddress = await offchainSigner.getAddress();

    verifyingSingletonPaymaster =
      await new VerifyingSingletonPaymaster__factory(deployer).deploy(
        await deployer.getAddress(),
        entryPoint.address,
        offchainSignerAddress
      );

    const BaseImplementation = await ethers.getContractFactory("SmartAccount");
    baseImpl = await BaseImplementation.deploy(entryPoint.address);
    await baseImpl.deployed();
    console.log("base wallet impl deployed at: ", baseImpl.address);

    const WalletFactory = await ethers.getContractFactory(
      "SmartAccountFactory"
    );
    walletFactory = await WalletFactory.deploy(baseImpl.address);
    await walletFactory.deployed();
    console.log("wallet factory deployed at: ", walletFactory.address);

    const MockToken = await ethers.getContractFactory("MockToken");
    token = await MockToken.deploy();
    await token.deployed();
    console.log("Test token deployed at: ", token.address);

    const Storage = await ethers.getContractFactory("StorageSetter");
    storage = await Storage.deploy();
    console.log("storage setter contract deployed at: ", storage.address);

    const MultiSend = await ethers.getContractFactory("MultiSend");
    multiSend = await MultiSend.deploy();
    console.log("Multisend helper contract deployed at: ", multiSend.address);

    const AllowanceModule = await ethers.getContractFactory("AllowanceModule");
    allowanceModule = await AllowanceModule.deploy();
    console.log("Test module deployed at ", allowanceModule.address);

    console.log("mint tokens to owner address..");
    await token.mint(owner, ethers.utils.parseEther("1000000"));

    /* paymasterAddress = verifyingSingletonPaymaster.address;
    console.log("Paymaster address is ", paymasterAddress);

    await verifyingSingletonPaymaster
      .connect(deployer)
      .addStake(10, { value: parseEther("2") });
    console.log("paymaster staked");

    await verifyingSingletonPaymaster.depositFor(
      await offchainSigner.getAddress(),
      { value: ethers.utils.parseEther("1") }
    );

    await entryPoint.depositTo(paymasterAddress, { value: parseEther("10") }); */
  });

  describe("Allowance Module transactions for Smart Account", function () {
    it("can enable Allowance modules and send allowed transactions: nonERC4337 flow", async function () {
      this.timeout(600000000);
      const expectedSmartAccountAddress =
        await walletFactory.getAddressForCounterFactualAccount(owner, 10);

      // deploying now
      await walletFactory.deployCounterFactualAccount(owner, 10);

      userSCW = await ethers.getContractAt(
        "contracts/smart-contract-wallet/SmartAccount.sol:SmartAccount",
        expectedSmartAccountAddress
      );

      const code = await ethers.provider.getCode(expectedSmartAccountAddress);
      console.log("wallet code is: ", code);

      await token
        .connect(accounts[0])
        .transfer(expectedSmartAccountAddress, ethers.utils.parseEther("100"));

      // Owner itself can not directly add modules
      await expect(
        userSCW.connect(accounts[0]).enableModule(allowanceModule.address)
      ).to.be.reverted;

      // Modules can only be enabled via safe transaction
      await expect(
        executeContractCallWithSigners(
          userSCW,
          userSCW,
          "enableModule",
          [allowanceModule.address],
          [accounts[0]]
        )
      ).to.emit(userSCW, "ExecutionSuccess");

      expect(await token.balanceOf(charlie)).to.equal(
        ethers.utils.parseEther("0")
      );

      // Add delegate : (later we will do this actions using multisend and delegateCall)

      const AllowanceModule = await ethers.getContractFactory(
        "AllowanceModule"
      );

      const addDelegateData = AllowanceModule.interface.encodeFunctionData(
        "addDelegate",
        [bob]
      );

      // Modules can only be enabled via safe transaction
      const safeTx: SafeTransaction = buildSafeTransaction({
        to: allowanceModule.address,
        // value: ethers.utils.parseEther("1"),
        data: addDelegateData,
        nonce: await userSCW.getNonce(EOA_CONTROLLED_FLOW),
      });

      const chainId = await userSCW.getChainId();
      const { signer, data } = await safeSignTypedData(
        accounts[0],
        userSCW,
        safeTx,
        chainId
      );

      console.log(safeTx);

      const transaction: Transaction = {
        to: safeTx.to,
        value: safeTx.value,
        data: safeTx.data,
        operation: safeTx.operation,
        targetTxGas: safeTx.targetTxGas,
      };
      const refundInfo: FeeRefund = {
        baseGas: safeTx.baseGas,
        gasPrice: safeTx.gasPrice,
        tokenGasPriceFactor: safeTx.tokenGasPriceFactor,
        gasToken: safeTx.gasToken,
        refundReceiver: safeTx.refundReceiver,
      };

      let signature = "0x";
      signature += data.slice(2);

      await expect(
        userSCW
          .connect(accounts[0])
          .execTransaction_S6W(transaction, refundInfo, signature)
      ).to.emit(userSCW, "ExecutionSuccess");

      const delegates = await allowanceModule.getDelegates(
        userSCW.address,
        0,
        10
      );
      expect(delegates.results.length).to.be.equal(1);
      expect(delegates.results[0].toLowerCase()).to.be.equal(bob.toLowerCase());

      // Add allowance

      const startTime = currentMinutes() - 30;

      const setAllowanceData = AllowanceModule.interface.encodeFunctionData(
        "setAllowance",
        [bob, token.address, ethers.utils.parseEther("10"), 60 * 24, startTime]
      );

      // Modules can only be enabled via safe transaction
      const safeTx2: SafeTransaction = buildSafeTransaction({
        to: allowanceModule.address,
        // value: ethers.utils.parseEther("1"),
        data: setAllowanceData,
        nonce: await userSCW.getNonce(EOA_CONTROLLED_FLOW),
      });

      const signedData = await safeSignTypedData(
        accounts[0],
        userSCW,
        safeTx2,
        chainId
      );

      console.log(safeTx);

      const transaction2: Transaction = {
        to: safeTx2.to,
        value: safeTx2.value,
        data: safeTx2.data,
        operation: safeTx2.operation,
        targetTxGas: safeTx2.targetTxGas,
      };
      const refundInfo2: FeeRefund = {
        baseGas: safeTx2.baseGas,
        gasPrice: safeTx2.gasPrice,
        tokenGasPriceFactor: safeTx2.tokenGasPriceFactor,
        gasToken: safeTx2.gasToken,
        refundReceiver: safeTx2.refundReceiver,
      };

      let signature2 = "0x";
      signature2 += signedData.data.slice(2);

      await expect(
        userSCW
          .connect(accounts[0])
          .execTransaction_S6W(transaction2, refundInfo2, signature2)
      ).to.emit(userSCW, "ExecutionSuccess");

      const tokens = await allowanceModule.getTokens(userSCW.address, bob);
      expect(tokens.length).to.be.equal(1);
      expect(tokens[0]).to.be.equal(token.address);
      const allowance = await allowanceModule.getTokenAllowance(
        userSCW.address,
        bob,
        token.address
      );
      console.log("allowance ", allowance);
      const startResetTime = await calculateResetTime(startTime, 24 * 60);
      expect(allowance[0]).to.be.equal(ethers.utils.parseEther("10"));

      expect(allowance[1]).to.be.equal(BigNumber.from(0));
      expect(allowance[2]).to.be.equal(BigNumber.from(1440));
      expect(allowance[3]).to.be.equal(
        BigNumber.from(startResetTime.toString())
      );
      expect(allowance[4]).to.be.equal(BigNumber.from(1));

      // let's make use of allowance module

      // Offset time by 45 min to check that limit is set in specified interval
      await wait(12 * 60 * 60);
      const nonce = allowance[4].toNumber();

      const transferHash = await allowanceModule.generateTransferHash(
        userSCW.address,
        token.address,
        charlie,
        ethers.utils.parseEther("5"),
        AddressZero,
        0,
        nonce
      );

      const delegatesAgain = await allowanceModule.getDelegates(
        userSCW.address,
        0,
        10
      );
      expect(delegatesAgain.results.length).to.be.equal(1);
      expect(delegatesAgain.results[0].toLowerCase()).to.be.equal(
        bob.toLowerCase()
      );

      console.log("transferHash ", transferHash);

      const typedDataHash = utils.arrayify(transferHash);

      const signatureDelegate = (await accounts[1].signMessage(typedDataHash))
        .replace(/1b$/, "1f")
        .replace(/1c$/, "20");
      console.log("signatureDelegate ", signatureDelegate);

      await allowanceModule.executeAllowanceTransfer(
        userSCW.address,
        token.address,
        charlie,
        ethers.utils.parseEther("5"),
        AddressZero,
        0,
        bob,
        signatureDelegate
      );

      expect(await token.balanceOf(charlie)).to.equal(
        ethers.utils.parseEther("5")
      );

      expect(await token.balanceOf(expectedSmartAccountAddress)).to.equal(
        ethers.utils.parseEther("95")
      );
    });
  });
});
