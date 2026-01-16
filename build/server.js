"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const http = __importStar(require("http"));
const app_1 = __importDefault(require("./app"));
const env_config_1 = __importDefault(require("./config/env.config"));
// import './workers/order.worker';
const logger_1 = __importDefault(require("./config/logger"));
const server = http.createServer(app_1.default);
// Schedule cron job to send notification
// cron.schedule('* * * * *', () => {
//     console.log('Checking for scheduled notifications...');
//     flutterwaveService.getBanks().catch((error) => {
//         console.error('Failed to process banks', error);
//     });
// });
// paystackService.getAllBanks()
//   .then(() => {
//     console.log('Banks fetched and saved successfully.');
//   })
//   .catch((error) => {
//     console.error('Failed to process banks:', error);
// });
// cron.schedule('* * * * *', () => {
//     console.log('starting pair sync...');
//     pairService.syncStablecoinPairs().catch((error) => {
//         console.error('Failed to process sync', error);
//     });
// });
server.listen(env_config_1.default.port, async () => {
    console.log(`Listening on port ${env_config_1.default.port}`);
    logger_1.default.info(`Server running on port ${env_config_1.default.port}`);
    // if (process.env.NODE_ENV !== 'dev') {
    try {
        //   await import('./workers/order.worker');
        await Promise.resolve().then(() => __importStar(require('./workers/general.worker')));
        //   await startWorker();
        console.log('All workers started successfully');
    }
    catch (err) {
        console.error('Failed to start workers:', err);
        // Don't crash the server if worker fails
    }
    //   }
});
