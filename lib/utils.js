const { ethers } = require('ethers');
const contractConfig = require('../config/contract.json');
const rpcConfig = require('../config/rpc.json');

function getRandomRpcProvider() {
  const rpcUrl = rpcConfig.rpcs[Math.floor(Math.random() * rpcConfig.rpcs.length)];
  return new ethers.JsonRpcProvider(rpcUrl);
}

function getWalletWithProvider(privateKey) {
  const provider = getRandomRpcProvider();
  return new ethers.Wallet(privateKey, provider);
}

async function getCurrentGasSettings() {
  const provider = getRandomRpcProvider();
  try {
    const feeData = await provider.getFeeData();
    
    // Base Chain biasanya sangat murah, batasi maksimal 0.1 Gwei
    const maxAllowedFee = ethers.parseUnits('0.1', 'gwei');
    const maxAllowedPriority = ethers.parseUnits('0.05', 'gwei');
    
    let baseMaxFee = feeData.maxFeePerGas || maxAllowedFee;
    let basePriorityFee = feeData.maxPriorityFeePerGas || maxAllowedPriority;
    
    // Jika lebih tinggi dari batas, gunakan batas
    if (baseMaxFee > maxAllowedFee) baseMaxFee = maxAllowedFee;
    if (basePriorityFee > maxAllowedPriority) basePriorityFee = maxAllowedPriority;
    
    return {
      maxFeePerGas: baseMaxFee,
      maxPriorityFeePerGas: basePriorityFee
    };
  } catch (error) {
    console.log('Error getting gas data, using safe defaults for Base');
    return {
      maxFeePerGas: ethers.parseUnits('0.05', 'gwei'),
      maxPriorityFeePerGas: ethers.parseUnits('0.02', 'gwei')
    };
  }
}



function isMintTime() {
  const currentTime = Math.floor(Date.now() / 1000);
  return currentTime >= contractConfig.startTimePhase2;
}

function isMintEnded() {
  const currentTime = Math.floor(Date.now() / 1000);
  return currentTime >= contractConfig.endTimePhase2;
}

// Tambahkan fungsi getDefaultProvider untuk kompatibilitas
function getDefaultProvider() {
  return getRandomRpcProvider();
}

module.exports = {
  getRandomRpcProvider,
  getWalletWithProvider,
  getCurrentGasSettings,
  isMintTime,
  isMintEnded,
  getDefaultProvider // Tambahkan fungsi ini
};
