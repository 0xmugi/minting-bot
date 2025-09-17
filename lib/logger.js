const Table = require('cli-table3');

class Logger {
  constructor() {
    this.table = new Table({
      head: ['Wallet', 'Status', 'Tx Hash', 'Attempts', 'Time'],
      colWidths: [20, 35, 65, 10, 15],
      style: {
        head: ['cyan', 'bold'],
        border: ['grey'],
        compact: true
      }
    });
  }

  addSeparator() {
    this.table.push([
      { colSpan: 5, content: '─'.repeat(150), hAlign: 'center' }
    ]);
  }

  clearTable() {
    this.table.splice(0, this.table.length);
  }
}

module.exports = Logger;