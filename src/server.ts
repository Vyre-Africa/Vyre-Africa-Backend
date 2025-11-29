import * as http from "http";
import app from "./app";
import env from "./config/env.config";
// import './workers/order.worker';
import logger from "./config/logger";
import cron from 'node-cron';
import adminBroadcastController from "./controllers/admin/admin.broadcast.controller";
import orderController from "./controllers/order.controller";
import paystackService from "./services/paystack.service";
import flutterwaveService from "./services/flutterwave.service";
import pairService from "./services/pair.service";

const server = http.createServer(app);

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


server.listen(env.port, async() => {
	console.log(`Listening on port ${env.port}`);
	logger.info(`Server running on port ${env.port}`);

	// if (process.env.NODE_ENV !== 'dev') {
		try {
		  await import('./workers/order.worker');
		  await import('./workers/general.worker');
		//   await startWorker();
		  console.log('All workers started successfully');
		} catch (err) {
		  console.error('Failed to start workers:', err);
		  // Don't crash the server if worker fails
		}
	//   }
});

