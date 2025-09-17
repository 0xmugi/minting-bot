const { ethers } = require('ethers');
const Logger = require('./logger');
const utils = require('./utils');
const contractConfig = require('../config/contract.json');
const walletConfig = require('../config/wallets.json');

class PreSignBot {
  constructor() {
    this.logger = new Logger();
    this.contract = null;
    this.signedTxs = [];
    this.wallets = [];
    this.gasPrices = new Map();
    this.results = new Map();
    this.eligibleWallets = new Map();
    this.launchpadFee = BigInt(contractConfig.launchpadFee);
    this.launchpadAddress = contractConfig.launchpadAddress;
  }

  async initialize() {
    try {
      console.log('Initializing wallets...');
      this.wallets = walletConfig.privateKeys.map(pk => {
        try {
          // Perbaikan: Gunakan getWalletWithProvider dari utils
          const fixedPk = pk.startsWith('0x') ? pk : `0x${pk}`;
          return utils.getWalletWithProvider(fixedPk);
        } catch (error) {
          console.log('Error creating wallet:', error.message);
          return null;
        }
      }).filter(wallet => wallet !== null);

      if (this.wallets.length === 0) {
        throw new Error('No valid wallets found');
      }

      console.log('Initializing contract...');
      const contractABI = contractConfig.abi;
      const provider = utils.getRandomRpcProvider();
      this.contract = new ethers.Contract(contractConfig.address, contractABI, provider);
      
      // Initialize results for all wallets
      this.wallets.forEach(wallet => {
        this.results.set(wallet.address, {
          status: 'Checking eligibility...',
          txHash: '',
          attempts: 0,
          success: false,
          gasUsed: '0',
          eligible: false
        });
      });

      // Validasi konfigurasi
      if (this.launchpadFee <= 0) {
        throw new Error('Invalid launchpad fee in config');
      }
      if (!ethers.isAddress(this.launchpadAddress)) {
        throw new Error('Invalid launchpad address in config');
      }

      console.log('Initialization completed successfully');
    } catch (error) {
      console.error('Initialization failed:', error.message);
      throw error;
    }
  }

  async checkEligibility() {
    console.log('Checking eligibility for all wallets...');
    
    for (const [index, wallet] of this.wallets.entries()) {
      try {
        const walletResult = this.results.get(wallet.address);
        walletResult.status = 'Checking eligibility...';
        this.updateAllWallets();
        
        const isEligible = await this.isWalletEligible(wallet.address);
        
        walletResult.eligible = isEligible;
        walletResult.status = isEligible ? 'ELIGIBLE ✅' : 'NOT ELIGIBLE ❌';
        
        this.eligibleWallets.set(wallet.address, isEligible);
        this.updateAllWallets();
        
        await new Promise(resolve => setTimeout(resolve, 100));
        
      } catch (error) {
        const walletResult = this.results.get(wallet.address);
        walletResult.status = `Eligibility Error: ${error.message}`;
        walletResult.eligible = false;
        this.eligibleWallets.set(wallet.address, false);
        this.updateAllWallets();
      }
    }
  }

  async isWalletEligible(walletAddress) {
    try {
      // Implementasi sederhana - return true untuk semua wallet
      // Di production, gunakan merkle tree verification
      return true;
    } catch (error) {
      console.log(`Eligibility check failed for ${walletAddress}:`, error.message);
      return false;
    }
  }

  generateMerkleProof(walletAddress) {
    try {
      // Gunakan merkle root dari config
      return [contractConfig.merkleRootPhase2];
    } catch (error) {
      console.log('Error generating merkle proof:', error.message);
      return [];
    }
  }

updateAllWallets() {
  try {
    this.logger.clearTable();
    
    // Header tabel
    this.logger.table.push([
      'Wallet', 'Status', 'Tx Hash', 'Attempts', 'Time'
    ]);
    this.logger.addSeparator();
    
    // Add gas info - hanya jika ada data gas
    if (this.gasPrices.size > 0) {
      // Ambil gas info dari wallet pertama yang memiliki data gas
      const firstGasEntry = Array.from(this.gasPrices.values())[0];
      const maxFeeGwei = ethers.formatUnits(firstGasEntry.maxFeePerGas, 'gwei');
      const maxPriorityGwei = ethers.formatUnits(firstGasEntry.maxPriorityFeePerGas, 'gwei');
      
      this.logger.table.push([
        'GAS INFO', 
        `Max: ${parseFloat(maxFeeGwei).toFixed(2)} Gwei`, 
        `Priority: ${parseFloat(maxPriorityGwei).toFixed(2)} Gwei`, 
        'N/A', 
        new Date().toLocaleTimeString()
      ]);
      this.logger.addSeparator();
    }

    // Add fee info - format lebih sederhana
    const feeInEth = ethers.formatUnits(this.launchpadFee, 'ether');
    const shortAddress = this.launchpadAddress.slice(0, 6) + '...' + this.launchpadAddress.slice(-4);
    
    this.logger.table.push([
      'FEE INFO',
      `Fee: ${feeInEth} ETH`,
      `≈ $1 USD`,
      shortAddress, // Hanya alamat pendek tanpa teks "Address"
      new Date().toLocaleTimeString()
    ]);
    this.logger.addSeparator();

    // Add system info
    const currentTime = Math.floor(Date.now() / 1000);
    const timeUntilMint = contractConfig.startTimePhase2 - currentTime;
    const mintTime = new Date(contractConfig.startTimePhase2 * 1000).toLocaleTimeString();
    
    if (timeUntilMint > 0) {
      this.logger.table.push([
        'SYSTEM', 
        `Waiting ${timeUntilMint}s (${mintTime})`, 
        'N/A', 
        '0', 
        new Date().toLocaleTimeString()
      ]);
      this.logger.addSeparator();
    } else {
      this.logger.table.push([
        'SYSTEM', 
        'MINTING OPEN!', 
        'N/A', 
        '0', 
        new Date().toLocaleTimeString()
      ]);
      this.logger.addSeparator();
    }

    // Add all wallets dengan status eligibility
    this.wallets.forEach((wallet) => {
      const result = this.results.get(wallet.address);
      const shortAddress = `${wallet.address.slice(0, 6)}...${wallet.address.slice(-4)}`;
      const shortTxHash = result.txHash ? 
        `${result.txHash.slice(0, 6)}...${result.txHash.slice(-4)}` : 'N/A';
      
      // Perbaikan: Tampilkan gas Gwei untuk wallet jika tersedia
      const gasInfo = this.gasPrices.get(wallet.address) || {};
      let gasText = '';
      if (gasInfo.maxFeePerGas) {
        const gasGwei = parseFloat(ethers.formatUnits(gasInfo.maxFeePerGas, 'gwei')).toFixed(2);
        gasText = `(${gasGwei} Gwei)`;
      }
      
      const statusWithEligibility = result.eligible ? 
        `${result.status} ${gasText} ✅` : 
        `${result.status} ${gasText} ❌`;
      
      this.logger.table.push([
        shortAddress,
        statusWithEligibility,
        shortTxHash,
        result.attempts,
        new Date().toLocaleTimeString()
      ]);
    });

    console.clear();
    console.log(this.logger.table.toString());
    
    const totalWallets = this.wallets.length;
    const successful = Array.from(this.results.values()).filter(r => r.success).length;
    const eligible = Array.from(this.results.values()).filter(r => r.eligible).length;
    
    console.log(`\nTotal Wallets: ${totalWallets} | Eligible: ${eligible} | Successful: ${successful}`);
  } catch (error) {
    console.log('Error updating wallet display:', error.message);
  }
}


  async preSignTransactions() {
    const eligibleWallets = this.wallets.filter(wallet => 
      this.eligibleWallets.get(wallet.address) === true
    );

    console.log(`\nPre-signing for ${eligibleWallets.length} eligible wallets...`);

    for (const [index, wallet] of eligibleWallets.entries()) {
      try {
        const walletResult = this.results.get(wallet.address);
        
        if (!walletResult.eligible) {
          walletResult.status = 'SKIPPED (Not eligible)';
          this.updateAllWallets();
          continue;
        }

        walletResult.status = 'Getting gas price...';
        this.updateAllWallets();
        
        // Dapatkan gas price dari provider
        const baseGas = await utils.getCurrentGasSettings();
        
        // Hitung gas price dengan multiplier (130-160%)
        // Di dalam preSignTransactions():
const reasonableMultiplier = 130 + Math.floor(Math.random() * 30); // 130–160%
        const maxFeePerGas = (baseGas.maxFeePerGas * BigInt(reasonableMultiplier)) / 100n;
        const maxPriorityFeePerGas = (baseGas.maxPriorityFeePerGas * BigInt(reasonableMultiplier)) / 100n;

        // Batasi gas price jika terlalu tinggi
        const maxReasonableFee = ethers.parseUnits('50', 'gwei');
        const finalMaxFee = maxFeePerGas > maxReasonableFee ? maxReasonableFee : maxFeePerGas;
        const maxReasonablePriority = ethers.parseUnits('5', 'gwei');
        const finalMaxPriority = maxPriorityFeePerGas > maxReasonablePriority ? 
          maxReasonablePriority : maxPriorityFeePerGas;

        this.gasPrices.set(wallet.address, { 
          maxFeePerGas: finalMaxFee, 
          maxPriorityFeePerGas: finalMaxPriority 
        });

        walletResult.status = 'Building transaction...';
        this.updateAllWallets();

        // Generate merkle proof
        const merkleProof = this.generateMerkleProof(wallet.address);
        
        walletResult.status = 'Signing transaction...';
        this.updateAllWallets();

        // Bangun transaksi
        const tx = await this.contract.connect(wallet).mintPhase2.populateTransaction(
          merkleProof,
          1,
          {
            value: this.launchpadFee,
            maxFeePerGas: finalMaxFee,
            maxPriorityFeePerGas: finalMaxPriority
          }
        );

        const signedTx = await wallet.signTransaction(tx);
        
        this.signedTxs.push({
          signedTx,
          wallet: wallet.address,
          index: index,
          gasPrice: { maxFeePerGas: finalMaxFee, maxPriorityFeePerGas: finalMaxPriority }
        });
        
        walletResult.status = 'PRE-SIGNED READY';
        this.updateAllWallets();

      } catch (error) {
        const walletResult = this.results.get(wallet.address);
        const errorMsg = error.shortMessage || error.message;
        walletResult.status = `Pre-sign Error: ${errorMsg}`;
        console.error('Pre-sign error details:', error);
        this.updateAllWallets();
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }

  async sendAllTransactions() {
    this.logger.addSeparator();
    
    // Kirim semua transaksi secara paralel
    const sendPromises = this.signedTxs.map((signedTxObj) => 
      this.sendTransactionWithRetry(signedTxObj)
    );
    
    await Promise.allSettled(sendPromises);
  }

  async sendTransactionWithRetry(signedTxObj) {
    const walletAddress = signedTxObj.wallet;
    const walletResult = this.results.get(walletAddress);
    let attempts = 0;
    let success = false;

    while (!success && !utils.isMintEnded()) {
      attempts++;
      walletResult.attempts = attempts;
      
      try {
        walletResult.status = 'Sending transaction...';
        this.updateAllWallets();
        
        const provider = utils.getRandomRpcProvider();
        const txResponse = await provider.broadcastTransaction(signedTxObj.signedTx);
        
        walletResult.txHash = txResponse.hash;
        walletResult.status = 'Transaction sent';
        this.updateAllWallets();
        
        // Tunggu konfirmasi dengan timeout
        const receipt = await Promise.race([
          txResponse.wait(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 10000))
        ]);
        
        if (receipt.status === 1) {
          walletResult.status = 'MINT SUCCESS!';
          walletResult.success = true;
          walletResult.gasUsed = ethers.formatUnits(receipt.gasUsed * receipt.gasPrice, 'ether');
          this.updateAllWallets();
          success = true;
        } else {
          walletResult.status = 'Transaction failed';
          this.updateAllWallets();
        }
      } catch (error) {
        if (error.message.includes('replacement transaction underpriced') || 
            error.message.includes('already known')) {
          walletResult.status = 'Tx in mempool, waiting...';
          await new Promise(resolve => setTimeout(resolve, 2000));
        } else if (error.message.includes('nonce too low')) {
          walletResult.status = 'Nonce issue, re-signing...';
          await this.reSignTransaction(signedTxObj);
          await new Promise(resolve => setTimeout(resolve, 1000));
        } else if (error.message.includes('Timeout')) {
          walletResult.status = 'Timeout, retrying...';
          await new Promise(resolve => setTimeout(resolve, 1000));
        } else if (error.message.includes('InsufficientFunds')) {
          walletResult.status = 'Insufficient funds';
          success = true; // Stop retrying
        } else if (error.message.includes('InvalidLaunchpadFee')) {
          walletResult.status = 'Invalid fee, adjusting...';
          this.launchpadFee = await this.adjustLaunchpadFee();
          await this.reSignTransaction(signedTxObj);
          await new Promise(resolve => setTimeout(resolve, 1000));
        } else {
          walletResult.status = `Error: ${error.shortMessage || error.message.slice(0, 50)}...`;
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
        this.updateAllWallets();
      }
    }
  }

  async reSignTransaction(signedTxObj) {
    try {
      const wallet = this.wallets[signedTxObj.index];
      const walletResult = this.results.get(signedTxObj.wallet);
      
      // Dapatkan gas price yang lebih tinggi
      const currentGas = this.gasPrices.get(signedTxObj.wallet);
      const higherMultiplier = 220 + Math.floor(Math.random() * 80); // 220–300%
      const maxFeePerGas = (currentGas.maxFeePerGas * BigInt(higherMultiplier)) / 100n;
      const maxPriorityFeePerGas = (currentGas.maxPriorityFeePerGas * BigInt(higherMultiplier)) / 100n;

      this.gasPrices.set(signedTxObj.wallet, { maxFeePerGas, maxPriorityFeePerGas });

      // Generate ulang merkle proof
      const merkleProof = this.generateMerkleProof(wallet.address);
      
      const tx = await this.contract.connect(wallet).mintPhase2.populateTransaction(
        merkleProof,
        1,
        {
          value: this.launchpadFee,
          maxFeePerGas,
          maxPriorityFeePerGas
        }
      );

      const signedTx = await wallet.signTransaction(tx);
      signedTxObj.signedTx = signedTx;
      signedTxObj.gasPrice = { maxFeePerGas, maxPriorityFeePerGas };
      
      walletResult.status = 'RE-SIGNED WITH HIGHER GAS';
      this.updateAllWallets();
      
    } catch (error) {
      const walletResult = this.results.get(signedTxObj.wallet);
      walletResult.status = `Re-sign Error: ${error.message.slice(0, 50)}...`;
      this.updateAllWallets();
    }
  }

  async adjustLaunchpadFee() {
    try {
      // Coba dapatkan fee terbaru dari kontrak
      const newFee = await this.contract.launchpadFee();
      console.log(`Updated launchpad fee to: ${newFee.toString()} wei`);
      return newFee;
    } catch (error) {
      // Jika gagal, naikkan 10%
      const adjustedFee = this.launchpadFee * 110n / 100n;
      console.log(`Adjusted launchpad fee to: ${adjustedFee.toString()} wei`);
      return adjustedFee;
    }
  }

  async refreshGasPrices() {
  const baseGas = await utils.getCurrentGasSettings();
  
  this.wallets.forEach(wallet => {
    if (!this.eligibleWallets.get(wallet.address)) return;
    
    // Di dalam preSignTransactions():
const reasonableMultiplier = 130 + Math.floor(Math.random() * 30); // 130–160%

    const maxFeePerGas = (baseGas.maxFeePerGas * BigInt(reasonableMultiplier)) / 100n;
    const maxPriorityFeePerGas = (baseGas.maxPriorityFeePerGas * BigInt(reasonableMultiplier)) / 100n;

    this.gasPrices.set(wallet.address, { 
      maxFeePerGas, 
      maxPriorityFeePerGas 
    });
  });
  
  console.log('Gas prices refreshed');
}

  async run() {
    try {
      console.log('Starting PreSign Bot with Eligibility Check...');
      await this.initialize();
      this.updateAllWallets();
      
      // Step 1: Check eligibility
      await this.checkEligibility();
      
      // Step 2: Pre-sign transactions
      await this.preSignTransactions();
      
      // Tunggu sampai waktu mint
      const currentTime = Math.floor(Date.now() / 1000);
      const timeToWait = contractConfig.startTimePhase2 - currentTime;
      
  if (timeToWait > 0) {
    console.log(`\nWaiting ${timeToWait} seconds until mint time...`);
    for (let i = timeToWait; i > 0; i--) {
      // Refresh gas fee setiap 30 detik
      if (i % 5 === 0) {
        await this.refreshGasPrices();
      }
      
      // Update status
      this.results.forEach((result, address) => {
        if (!result.success && result.eligible) {
          result.status = `Waiting ${i}s...`;
        }
      });
      this.updateAllWallets();
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
      
      // Step 3: Kirim transactions
      console.log('\n=== MINT TIME - SENDING TRANSACTIONS ===');
      await this.sendAllTransactions();
      
      // Final update
      this.updateAllWallets();
      console.log('\n=== MINTING COMPLETED ===');
      const successful = Array.from(this.results.values()).filter(r => r.success).length;
      const eligible = Array.from(this.results.values()).filter(r => r.eligible).length;
      console.log(`Eligible: ${eligible} | Successful: ${successful}/${this.wallets.length}`);
      
    } catch (error) {
      console.error('Fatal error in bot execution:', error.message);
      console.error(error.stack);
    }
  }
}

module.exports = PreSignBot;
