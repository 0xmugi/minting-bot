const { ethers } = require('ethers');
const Logger = require('./logger');
const utils = require('./utils');
const contractConfig = require('../config/contract.json');
const walletConfig = require('../config/wallets.json'); // Wallets khusus untuk retry bot

class RetryBot {
  constructor() {
    this.logger = new Logger();
    this.contract = null;
    this.wallets = [];
    this.results = new Map();
    this.usedWallets = new Set(); // Untuk track wallet yang sudah berhasil
    this.eligibilityCache = new Map(); // cache eligibility per address
    this.proofCache = new Map(); // cache merkle proofs per address
    this.providerPool = []; // optionally hold multiple providers for rotation
    this.maxReceiptWait = 60 * 1000; // 60s - timeout untuk menunggu receipt (dapat disesuaikan)
  }

  async initialize() {
    try {
      // build wallets array defensif
      this.wallets = walletConfig.privateKeys.map(pk => {
        try {
          // utils.getWalletWithProvider harus tetap dipakai (user existing)
          return utils.getWalletWithProvider(pk);
        } catch (error) {
          console.log(`Error creating wallet: ${error.message}`);
          return null;
        }
      }).filter(w => w !== null);

      if (this.wallets.length === 0) {
        throw new Error('No valid retry wallets found');
      }

      // prepare provider pool (jika utils punya provider list, gunakan)
      try {
        // utils.getRpcProviders dapatkah tersedia? kalau tidak, fallback ke getRandomRpcProvider
        if (utils.getRpcProviders && typeof utils.getRpcProviders === 'function') {
          this.providerPool = utils.getRpcProviders();
        } else {
          // buat pool kecil dari beberapa provider calls getRandomRpcProvider berkali-kali
          for (let i = 0; i < Math.max(2, Math.min(6, this.wallets.length)); i++) {
            this.providerPool.push(utils.getRandomRpcProvider());
          }
        }
      } catch (err) {
        // fallback ke 1 provider
        this.providerPool = [utils.getRandomRpcProvider()];
      }

// primary contract instance (read-only) connected to a provider (rotate later for writes)
const readProvider = this.providerPool[0];
this.contract = new ethers.Contract(contractConfig.address, contractConfig.abi, readProvider);

// KONVERSI launchpadFee ke BigNumber SEKALI SAJA
console.log('Loaded contractConfig:', contractConfig);
contractConfig.launchpadFee = BigInt(contractConfig.launchpadFee);


      // init results map
      this.wallets.forEach(wallet => {
        this.results.set(wallet.address, {
          status: 'Waiting',
          txHash: '',
          attempts: 0,
          success: false,
          lastError: ''
        });
      });
    } catch (error) {
      console.error('Initialization failed:', error.message);
      throw error;
    }
  }

  updateAllWallets() {
    try {
      this.logger.clearTable();
      this.logger.table.push([
        'Wallet', 'Status', 'Tx Hash', 'Attempts', 'Time'
      ]);
      this.logger.addSeparator();

      const currentTime = Math.floor(Date.now() / 1000);
      const timeUntilMint = contractConfig.startTimePhase2 - currentTime;
      const mintTime = new Date(contractConfig.startTimePhase2 * 1000).toLocaleTimeString();

      if (timeUntilMint > 0) {
        this.logger.table.push([
          'SYSTEM',
          `Waiting ${timeUntilMint}s (${mintTime})`,
          '-', 'N/A', '0', new Date().toLocaleTimeString()
        ]);
        this.logger.addSeparator();
      } else {
        this.logger.table.push([
          'SYSTEM',
          'MINTING OPEN!',
          '-', 'N/A', '0', new Date().toLocaleTimeString()
        ]);
        this.logger.addSeparator();
      }

      this.wallets.forEach(wallet => {
        const result = this.results.get(wallet.address);
        const shortAddress = `${wallet.address.slice(0, 6)}...${wallet.address.slice(-4)}`;
        const shortTxHash = result.txHash ?
          `${result.txHash.slice(0, 6)}...${result.txHash.slice(-4)}` : 'N/A';
        const eligIcon = result.eligible ? '✅' : '❌';
        this.logger.table.push([
          shortAddress,
          result.status,
          shortTxHash,
          result.attempts,
          new Date().toLocaleTimeString()
        ]);
      });

      console.clear();
      console.log(this.logger.table.toString());
      const successful = Array.from(this.results.values()).filter(r => r.success).length;
      console.log(`\nTotal Wallets: ${this.wallets.length} | Successful: ${successful}`);
    } catch (error) {
      console.log('Error updating wallet display:', error.message);
    }
  }

  // helper: select provider from pool (round-robin/random)
  _pickProvider() {
    if (!this.providerPool || this.providerPool.length === 0) {
      return utils.getRandomRpcProvider();
    }
    // random pick to reduce single node overload
    const idx = Math.floor(Math.random() * this.providerPool.length);
    return this.providerPool[idx];
  }

  // cache merkle proof per address to avoid repeated calculation
  async getMerkleProofCached(address) {
    if (this.proofCache.has(address)) return this.proofCache.get(address);
    try {
      const leaf = utils.hashAddress(address);
      const proof = utils.getMerkleProof(leaf, contractConfig.merkleRootPhase2);
      this.proofCache.set(address, proof);
      return proof;
    } catch (err) {
      // store empty array to avoid repeated failing attempts
      this.proofCache.set(address, []);
      return [];
    }
  }

  async checkEligibility(wallet) {
    try {
      if (this.eligibilityCache.has(wallet.address)) {
        return this.eligibilityCache.get(wallet.address);
      }
      // if contract has isEligible, use it. otherwise, attempt proof + call if present
      let eligible = false;
      const proof = await this.getMerkleProofCached(wallet.address);

      if (typeof this.contract.isEligible === 'function') {
        // call read-only contract method
        eligible = await this.contract.isEligible(wallet.address, proof);
      } else if (proof && proof.length > 0) {
        // fallback: assume proof presence implies eligible (best-effort)
        eligible = true;
      } else {
        eligible = false;
      }

      this.eligibilityCache.set(wallet.address, eligible);
      return eligible;
    } catch (err) {
      console.log(`Eligibility check failed for ${wallet.address}: ${err.message}`);
      // don't spam cache with false negatives, but set small TTL via memory map (could be improved)
      this.eligibilityCache.set(wallet.address, false);
      return false;
    }
  }

  // Generic "already minted" checker: try balanceOf if contract supports ERC-721/ERC-1155-like interface.
  async isAlreadyMinted(_walletAddress) {
    try {
      if (!this.contract) return false;
      // If contract has balanceOf -> use it (safe read)
      if (typeof this.contract.balanceOf === 'function') {
        try {
          // some contracts expect address only
          const bal = await this.contract.balanceOf(_walletAddress);
          // ethers BigNumber
          if (bal && bal.gt && bal.gt(0)) return true;
          return false;
        } catch (err) {
          // ignore and try other checks below
        }
      }

      // If contract exposes hasMinted or minted mapping name, try common patterns (best-effort)
      const possibleFns = ['hasMinted', 'alreadyMinted', 'minted', 'mintedCount'];
      for (const fn of possibleFns) {
        if (typeof this.contract[fn] === 'function') {
          try {
            const res = await this.contract[fn](_walletAddress);
            if (typeof res === 'boolean') return !!res;
            if (res && res.gt && res.gt(0)) return true;
          } catch (e) {
            // ignore and continue
          }
        }
      }

      // As last resort, assume not minted
      return false;
    } catch (error) {
      console.log(`Error checking if already minted: ${error.message}`);
      return false;
    }
  }

  // wait for receipt with timeout; poll for receipt to avoid blocking too long on provider
  async waitForReceiptWithTimeout(provider, txHash, timeoutMs = this.maxReceiptWait) {
    const pollInterval = 1000; // 1s
    const start = Date.now();

    // first, try provider.waitForTransaction (some providers support timeout param)
    try {
      if (provider.waitForTransaction) {
        // provider.waitForTransaction(txHash, confirmations?, timeout)
        const receipt = await provider.waitForTransaction(txHash, 1, timeoutMs);
        return receipt;
      }
    } catch (err) {
      // ignore: fallback to manual polling
    }

    // manual polling loop
    while (Date.now() - start < timeoutMs) {
      try {
        const receipt = await provider.getTransactionReceipt(txHash);
        if (receipt) return receipt;
      } catch (err) {
        // ignore transient errors
      }
      await new Promise(r => setTimeout(r, pollInterval));
    }
    // timed out
    return null;
  }

  // tryMint improved
  async tryMint(origWallet) {
    const walletResult = this.results.get(origWallet.address);
    walletResult.attempts++;
    walletResult.lastError = '';
    try {
      if (this.usedWallets.has(origWallet.address)) {
        walletResult.status = 'Already used';
        this.updateAllWallets();
        return true;
      }

      // eligibility check cached/deterministic
      const isEligible = await this.checkEligibility(origWallet);
      walletResult.eligible = isEligible;
      if (!isEligible) {
        walletResult.status = 'Not eligible';
        this.updateAllWallets();
        return false;
      }

      // double-check already minted
      walletResult.status = 'Checking already minted...';
      this.updateAllWallets();
      if (await this.isAlreadyMinted(origWallet.address)) {
        walletResult.status = 'Already minted';
        walletResult.success = true;
        this.usedWallets.add(origWallet.address);
        this.updateAllWallets();
        return true;
      }

      // prepare provider & signer (rotate provider to reduce overload)
      const provider = this._pickProvider();
      // ensure we have a signer connected to this provider
      let wallet;
      try {
        wallet = origWallet.connect(provider);
      } catch (err) {
        // if origWallet already had provider, reconnect by creating Wallet from privateKey
        if (origWallet.privateKey) {
          wallet = new ethers.Wallet(origWallet.privateKey, provider);
        } else {
          // as last resort, use origWallet (may still work)
          wallet = origWallet;
        }
      }

      walletResult.status = 'Getting gas price...';
      this.updateAllWallets();

      // get base gas settings from utils; fallback to provider.getFeeData
      let baseGas = null;
      try {
        baseGas = await utils.getCurrentGasSettings(); // expected returns { maxFeePerGas, maxPriorityFeePerGas } as BigNumber
      } catch (e) {
        // fallback
        try {
          const feeData = await provider.getFeeData();
          baseGas = {
            maxFeePerGas: feeData.maxFeePerGas || feeData.gasPrice || ethers.BigNumber.from('0'),
            maxPriorityFeePerGas: feeData.maxPriorityFeePerGas || ethers.BigNumber.from('0')
          };
        } catch (err) {
          // final fallback: set small default values (user should ensure reasonable values)
          baseGas = {
            maxFeePerGas: ethers.utils.parseUnits('2', 'gwei'),
            maxPriorityFeePerGas: ethers.utils.parseUnits('1', 'gwei')
          };
        }
      }

      // apply a slight random multiplier but using BigNumber math
      const multiplier = 1.05 + (Math.random() * 0.5); // 1.05 - 1.55
      const mulFactor = Math.floor(multiplier * 100); // integer
      const maxFeePerGas = baseGas.maxFeePerGas.mul(ethers.BigNumber.from(mulFactor)).div(ethers.BigNumber.from(100));
      const maxPriorityFeePerGas = baseGas.maxPriorityFeePerGas.mul(ethers.BigNumber.from(mulFactor)).div(ethers.BigNumber.from(100));

      walletResult.status = 'Building transaction...';
      this.updateAllWallets();

      // get merkle proof cached
      const merkleProof = await this.getMerkleProofCached(origWallet.address);

      walletResult.status = 'Preparing nonce...';
      this.updateAllWallets();

      // get nonce in 'pending' to avoid nonce collision
      let nonce;
      try {
        nonce = await wallet.getTransactionCount('pending');
      } catch (err) {
        // fallback
        nonce = await wallet.getTransactionCount();
      }

      // small defensive gas estimation for call data if possible
      let gasLimit = null;
      try {
        // try estimateGas from contract connect (read-only provider) or signer
        const contractForEstimate = this.contract.connect(provider);
        const estimated = await contractForEstimate.estimateGas.mintPhase2
          ? await contractForEstimate.estimateGas.mintPhase2(merkleProof, 1, {
              value: contractConfig.launchpadFee,
              from: wallet.address
            })
          : null;
        if (estimated && estimated.gt(0)) {
          // add buffer
          gasLimit = estimated.mul(110).div(100); // +10%
        }
      } catch (err) {
        // ignore estimation failure
      }

      walletResult.status = 'Sending transaction...';
      this.updateAllWallets();

      // final safety check: isAlreadyMinted before send
      if (await this.isAlreadyMinted(origWallet.address)) {
        walletResult.status = 'Already minted';
        walletResult.success = true;
        this.usedWallets.add(origWallet.address);
        this.updateAllWallets();
        return true;
      }

      // build tx
      const txRequest = {
        to: contractConfig.address,
        // Note: using contract connect + populateTransaction to ensure data correctness
        nonce,
        maxFeePerGas,
        maxPriorityFeePerGas,
        value: contractConfig.launchpadFee
      };

      // get populated tx data via interface
      let populatedTx;
      try {
        const signerContract = this.contract.connect(wallet);
        populatedTx = await signerContract.populateTransaction.mintPhase2(merkleProof, 1, {
          value: contractConfig.launchpadFee
        });
        // copy data and to
        txRequest.data = populatedTx.data;
        txRequest.to = populatedTx.to || contractConfig.address;
      } catch (err) {
        // if populate fails, attempt direct contract call as fallback
        // Direct call:
        const tx = await this.contract.connect(wallet).mintPhase2(merkleProof, 1, {
          value: contractConfig.launchpadFee,
          nonce,
          maxFeePerGas,
          maxPriorityFeePerGas,
          gasLimit
        });
        // We will wait for tx below, so set tx.hash and continue
        walletResult.txHash = tx.hash;
        walletResult.status = 'Transaction sent (direct call)';
        this.updateAllWallets();
        const receipt = await this.waitForReceiptWithTimeout(provider, tx.hash);
        if (receipt && receipt.status === 1) {
          walletResult.status = 'MINT SUCCESS!';
          walletResult.success = true;
          this.usedWallets.add(origWallet.address);
          this.updateAllWallets();
          return true;
        } else if (receipt && receipt.status === 0) {
          walletResult.status = 'Transaction failed';
          this.updateAllWallets();
          return false;
        } else {
          walletResult.status = 'Receipt timeout';
          walletResult.lastError = 'Receipt timeout';
          this.updateAllWallets();
          return false;
        }
      }

      // apply gasLimit if we estimated earlier
      if (gasLimit) txRequest.gasLimit = gasLimit;

      // sign & send raw tx as last step (avoids automatic nonce interfering)
      const signedTx = await wallet.signTransaction(txRequest);
      const sent = await provider.sendTransaction(signedTx);
      walletResult.txHash = sent.hash;
      walletResult.status = 'Transaction sent (raw)';
      this.updateAllWallets();

      // wait for receipt with timeout/polling
      const receipt = await this.waitForReceiptWithTimeout(provider, sent.hash, this.maxReceiptWait);

      if (receipt && receipt.status === 1) {
        walletResult.status = 'MINT SUCCESS!';
        walletResult.success = true;
        this.usedWallets.add(origWallet.address);
        this.updateAllWallets();
        return true;
      } else if (receipt && receipt.status === 0) {
        walletResult.status = 'Transaction failed';
        this.updateAllWallets();
        return false;
      } else {
        walletResult.status = 'Receipt timeout';
        walletResult.lastError = 'Receipt timeout';
        this.updateAllWallets();
        return false;
      }
    } catch (error) {
      // categorize common errors for better status messages
      const msg = (error && (error.shortMessage || error.message)) || String(error);
      walletResult.lastError = msg;

      if (msg.includes('already minted') || msg.includes('alreadyMinted') || msg.includes('Already minted')) {
        walletResult.status = 'Already minted';
        walletResult.success = true;
        this.usedWallets.add(origWallet.address);
      } else if (msg.includes('insufficient funds')) {
        walletResult.status = 'Insufficient funds';
      } else if (msg.includes('nonce') || msg.includes('nonce too low') || msg.includes('replacement transaction underpriced')) {
        walletResult.status = 'Nonce issue';
      } else if (msg.includes('revert')) {
        walletResult.status = 'Contract revert';
      } else if (msg.includes('timeout') || msg.includes('timeout')) {
        walletResult.status = 'Timeout/Error';
      } else {
        walletResult.status = `Error: ${msg}`;
      }

      this.updateAllWallets();
      return false;
    }
  }

  async run() {
    try {
      await this.initialize();

      // initial eligibility checks before countdown
      await Promise.all(this.wallets.map(async (w) => {
        const eligible = await this.checkEligibility(w);
        this.results.get(w.address).eligible = eligible;
      }));

      this.updateAllWallets();

      const currentTime = Math.floor(Date.now() / 1000);
      const timeToWait = contractConfig.startTimePhase2 - currentTime - 10;

      if (timeToWait > 0) {
        for (let i = timeToWait; i > 0; i--) {
          this.results.forEach((result) => {
            result.status = `Waiting ${i}s...`;
          });
          this.updateAllWallets();
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }

      // start mint retries for each wallet, but add small stagger and jitter
      const mintPromises = this.wallets.map((wallet, idx) => {
        // small stagger so not all wallets hit same ms
        const startDelay = Math.floor(Math.random() * 500) + (idx % 5) * 50;
        return new Promise(resolve => setTimeout(resolve, startDelay)).then(() => this.retryMintUntilSuccess(wallet));
      });

      await Promise.allSettled(mintPromises);
      this.updateAllWallets();
      console.log('\n=== MINTING COMPLETED ===');
      console.log(`Successful: ${Array.from(this.results.values()).filter(r => r.success).length}/${this.wallets.length}`);
    } catch (error) {
      console.error('Fatal error in retry bot:', error.message);
      console.error(error.stack);
    }
  }

  async retryMintUntilSuccess(wallet) {
    const walletResult = this.results.get(wallet.address);

    while (!walletResult.success && !utils.isMintEnded()) {
      const success = await this.tryMint(wallet);
      if (!success) {
        // exponential backoff with jitter, but bounded
        const attempts = Math.max(1, walletResult.attempts);
        const baseDelay = Math.min(1200 * Math.pow(1.4, attempts - 1), 15000); // grow but capped ~15s
        const jitter = Math.random() * 1200;
        await new Promise(resolve => setTimeout(resolve, baseDelay + jitter));
      }
    }
    return walletResult.success;
  }
}

module.exports = RetryBot;
