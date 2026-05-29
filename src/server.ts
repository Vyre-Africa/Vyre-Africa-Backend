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


server.listen(env.port, async() => {
	console.log(`Listening on port ${env.port}`);
	logger.info(`Server running on port ${env.port}`);

	// Only start workers if enabled via environment variable
	const START_WORKERS = process.env.START_WORKERS === 'true';
	
	if (START_WORKERS) {
		try {
			console.log('🔧 Starting background workers...');
			const { startGeneralWorker, startSweepWorkers } = await import('./workers/general.worker');

			startGeneralWorker();
            startSweepWorkers();
			console.log('✅ All workers started successfully');
		} catch (err) {
			console.error('❌ Failed to start workers:', err);
			// Don't crash the server if worker fails
		}
	} else {
		console.log('⏭️  Workers disabled (API only mode)');
	}
});

