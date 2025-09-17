const PreSignBot = require('./lib/preSignBot');
const RetryBot = require('./lib/retryBot');

const mode = process.argv[2];

async function main() {
  try {
    if (mode === 'pre-sign') {
      const bot = new PreSignBot();
      await bot.run();
    } else if (mode === 'retry') {
        console.log('RetryBot export:', require('./lib/retryBot'));

      const bot = new RetryBot();
      await bot.run();
    } else {
      console.log('Usage: node index.js [pre-sign|retry]');
      process.exit(1);
    }
  } catch (error) {
    console.error('Fatal error:', error);
    process.exit(1);
  }
}

main();