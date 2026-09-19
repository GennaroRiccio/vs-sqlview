const path = require('path');
const Mocha = require('mocha');

const mocha = new Mocha({
  ui: 'tdd',
  color: true,
});

mocha.addFile(path.resolve(__dirname, '../../out/test/suite/extension.test.js'));

mocha.run((failures) => {
  process.exitCode = failures ? 1 : 0;
});
