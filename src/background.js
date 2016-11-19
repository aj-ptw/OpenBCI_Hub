import net from 'net';
import { Ganglion, k } from 'openbci'; // native npm module
import menubar from 'menubar';
import * as _ from 'lodash';

/** TCP */
const kTcpActionStart = 'start';
const kTcpActionStatus = 'status';
const kTcpActionStop = 'stop';
const kTcpCmdConnect = 'c';
const kTcpCmdCommand = 'k';
const kTcpCmdData = 't';
const kTcpCmdDisconnect = 'd';
const kTcpCmdError = 'e';
const kTcpCmdImpedance = 'z';
const kTcpCmdLog = 'l';
const kTcpCmdScan = 's';
const kTcpCmdStatus = 'q';
const kTcpCodeBadPacketData = 500;
const kTcpCodeSuccess = 200;
const kTcpCodeGanglionFound = 201;
const kTcpCodeStatusConnected = 300;
const kTcpCodeStatusDisconnected = 301;
const kTcpCodeStatusScanning = 302;
const kTcpCodeStatusNotScanning = 303;
const kTcpCodeErrorUnknown = 499;
const kTcpCodeErrorAlreadyConnected = 408;
const kTcpCodeErrorCommandNotRecognized = 406;
const kTcpCodeErrorDeviceNotFound = 405;
const kTcpCodeErrorNoOpenBleDevice = 400;
const kTcpCodeErrorUnableToConnect = 402;
const kTcpCodeErrorUnableToDisconnect = 401;
const kTcpCodeErrorScanAlreadyScanning = 409;
const kTcpCodeErrorScanNoneFound = 407;
const kTcpCodeErrorScanNoScanToStop = 410;
const kTcpCodeErrorScanCouldNotStart = 412;
const kTcpCodeErrorScanCouldNotStop = 411;
const kTcpHost = '127.0.0.1';
const kTcpPort = 10996;
const kTcpStop = ',;\n';

let verbose = true;
let ganglion = new Ganglion({
  nobleScanOnPowerOn: false,
  sendCounts: true,
  verbose: verbose
});

let _client = null;

// Start a TCP Server
net.createServer((client) => {
  // Identify this client
  client.name = `${client.remoteAddress}:${client.remotePort}`;

  if (verbose) {
    console.log(`Welcome ${client.name}`);
  }

  // Put this new client in the list
  if (_.isNull(_client)) {
    _client = client;
    console.log('client set');

    // Handle incoming messages from clients.
    client.on('data', (data) => {
      if (verbose) {
        console.log(`server got: ${data} from ${client.name}`);
      }
      parseMessage(data, client);
    });

    // Remove the client from the list when it leaves
    client.on('end', () => {
      _client = null;
      if (verbose) {
        console.log(`${client.name} has left`);
      }
      client.removeAllListeners('data');
      client.removeAllListeners('end');
      client.removeAllListeners('error');
    });

    client.on('error', (err) => {
      if (verbose) {
        console.log(`Error from ${client.name}: ${err}`);
      }
    });
  }
}).listen({
  port: kTcpPort,
  host: kTcpHost
});

if (verbose) {
  console.log(`server listening on port ${kTcpHost}:${kTcpPort}`);
}

var writeOutToConnectedClient = (message) => {
  if (_client) {
    _client.write(message);
  } else {
    throw Error('no connected client');
  }
};

/**
 * Called when a new sample is emitted.
 * @param sample {Object}
 *  A sample object.
 */
var sampleFunction = (sample) => {
  let packet = '';
  packet = `${kTcpCmdData},${kTcpCodeSuccess},`;
  packet += sample.sampleNumber;
  for (var j = 0; j < sample.channelDataCounts.length; j++) {
    packet += ',';
    packet += sample.channelDataCounts[j];
  }
  packet += `${kTcpStop}`;
  writeOutToConnectedClient(packet);
};

var parseMessage = (msg, client) => {
  let msgElements = msg.toString().split(',');
  // var char = String.fromCharCode(msg[0])
  // console.log('msgElements[0]',msgElements[0],char)
  switch (msgElements[0]) {
    case kTcpCmdConnect:
      if (ganglion.isConnected()) {
        if (verbose) console.log('already connected');
        client.write(`${kTcpCmdConnect},${kTcpCodeErrorAlreadyConnected}${kTcpStop}`);
      } else {
        if (verbose) console.log(`attempting to connect to ${msgElements[1]}`);
        ganglion.on(k.OBCIEmitterReady, () => {
          client.write(`${kTcpCmdConnect},${kTcpCodeSuccess}${kTcpStop}`);
          ganglion.on('sample', sampleFunction);
        });
        ganglion.connect(msgElements[1]) // Port name is a serial port name, see `.listPorts()`
          .catch((err) => {
            client.write(`${kTcpCmdConnect},${kTcpCodeErrorUnableToConnect},${err}${kTcpStop}`);
          });
      }
      break;
    case kTcpCmdCommand:
      if (ganglion.isConnected()) {
        ganglion.write(msgElements[1])
          .then(() => {
            if (verbose) console.log(`sent ${msgElements[1]} to Ganglion`);
            client.write(`${kTcpCmdCommand},${kTcpCodeSuccess}${kTcpStop}`);
          })
          .catch((err) => {
            if (verbose) console.log('sendCharacteristic not set');
            client.write(`${kTcpCmdError},${err}${kTcpStop}`);
          });
      } else {
        client.write(`${kTcpCmdCommand},${kTcpCodeErrorNoOpenBleDevice}${kTcpStop}`);
      }
      break;
    case kTcpCmdDisconnect:
      ganglion.manualDisconnect = true;
      ganglion.disconnect()
        .then(() => {
          client.write(`${kTcpCmdDisconnect},${kTcpCodeSuccess}${kTcpStop}`);
        })
        .catch((err) => {
          client.write(`${kTcpCmdDisconnect},${kTcpCodeErrorUnableToDisconnect},${err}${kTcpStop}`);
        });
      break;
    case kTcpCmdScan:
      processScan(msg, client);
      break;
    case kTcpCmdStatus:
      // A simple loop back
      client.write(`${kTcpCmdStatus},${kTcpCodeSuccess}${kTcpStop}`);
      break;
    case kTcpCmdError:
    default:
      client.write(`${kTcpCmdError},${kTcpCodeBadPacketData},Error: command not recognized${kTcpStop}`);
      break;
  }
};

const processScan = (msg, client) => {
  const ganglionFound = (peripheral) => {
    const localName = peripheral.advertisement.localName;
    client.write(`${kTcpCmdScan},${kTcpCodeGanglionFound},${localName}${kTcpStop}`);
  };
  let msgElements = msg.toString().split(',');
  const action = msgElements[1];
  switch (action) {
    case kTcpActionStart:
      if (ganglion.isSearching()) {
        client.write(`${kTcpCmdScan},${kTcpCodeErrorScanAlreadyScanning}${kTcpStop}`);
      } else {
        ganglion.on(k.OBCIEmitterGanglionFound, ganglionFound);
        ganglion.searchStart()
          .then(() => {
            client.write(`${kTcpCmdScan},${kTcpCodeSuccess},${kTcpActionStart}${kTcpStop}`);
          })
          .catch((err) => {
            ganglion.removeListener(k.OBCIEmitterGanglionFound, ganglionFound);
            client.write(`${kTcpCmdScan},${kTcpCodeErrorScanCouldNotStart},${err}${kTcpStop}`);
          });
      }
      break;
    case kTcpActionStatus:
      if (ganglion.isSearching()) {
        client.write(`${kTcpCmdScan},${kTcpCodeStatusScanning}${kTcpStop}`);
      } else {
        client.write(`${kTcpCmdScan},${kTcpCodeStatusNotScanning}${kTcpStop}`);
      }
      break;
    case kTcpActionStop:
      if (ganglion.isSearching()) {
        ganglion.searchStop()
          .then(() => {
            ganglion.removeListener(k.OBCIEmitterGanglionFound, ganglionFound);
            client.write(`${kTcpCmdScan},${kTcpCodeSuccess},${kTcpActionStop}${kTcpStop}`);
          })
          .catch((err) => {
            client.write(`${kTcpCmdScan},${kTcpCodeErrorScanCouldNotStop},${err}${kTcpStop}`);
          });
      } else {
        client.write(`${kTcpCmdScan},${kTcpCodeErrorScanNoScanToStop},${kTcpStop}`);
      }
      break;
  }
};

function exitHandler (options, err) {
  if (options.cleanup) {
    if (verbose) console.log('clean');
    // console.log(connectedPeripheral)
    ganglion.manualDisconnect = true;
    ganglion.disconnect();
  }
  if (err) console.log(err.stack);
  if (options.exit) {
    if (verbose) console.log('exit');
    if (ganglion.isConnected()) {
      ganglion.disconnect()
        .then(() => {
          process.exit();
        })
        .catch((err) => {
          if (verbose) console.log(err);
          process.exit();
        });
    }
  }
}

let mb = menubar({
  icon: './resources/icons/icon.png'
});

mb.on('ready', function ready () {
  console.log('app is ready');
  // your app code here
});

mb.on('after-close', function () {
  exitHandler.bind(null, {
    cleanup: true
  });
});