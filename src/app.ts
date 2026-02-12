import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import bodyParser from 'body-parser';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import morgan from 'morgan';
import swaggerUi from 'swagger-ui-express';
import swaggerDocument from '../swagger-output.json';

const app = express();

import { initializeAdmin } from './config/firebaseConfig.js';
import { router } from './routes';

dotenv.config();

// CORS Configuration - MUST be before other middleware
const corsOptions = {
    origin: [
      'http://localhost:3000',
      'http://localhost:3001',
      'https://app.vyre.africa',
      'https://p2p.vyre.africa',
      'https://payments.vyre.africa',
      'https://swap.vyre.africa',
      'https://ideal-hedgehog-13788.upstash.io'
    ],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: [
      'Origin',
      'X-Requested-With',
      'Content-Type',
      'Accept',
      'Authorization'
    ],
    credentials: true,
    optionsSuccessStatus: 200
};

// // Apply CORS FIRST
// app.use(cors(corsOptions));

// // Handle preflight requests
// app.options('*', cors(corsOptions));

app.options('*', (req, res) => {
  const origin = req.headers.origin;
  const allowedOrigins = [
    'https://app.vyre.africa',
    'https://p2p.vyre.africa',
    'https://payments.vyre.africa',
    'https://swap.vyre.africa',
  ];
  
  if (origin && allowedOrigins.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
  }
  
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,PATCH,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin,X-Requested-With,Content-Type,Accept,Authorization');
  res.header('Access-Control-Allow-Credentials', 'true');
  res.sendStatus(200);
});

// FOR WEBHOOK handlers (these need raw body)
app.use('/api/v1/webhook/fern', express.raw({ type: 'application/json', limit: '10mb' }));
app.use('/api/v1/webhook/clerk', express.raw({ type: 'application/json', limit: '10mb' }));

// Body parsers
app.use(express.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true }));

// Other middleware
app.use(compression());
app.use(morgan('dev'));
app.use(cookieParser());

// ❌ REMOVE THIS - It's conflicting with cors package
// app.use(function (req, res, next) {
//     res.header(
//         'Access-Control-Allow-Headers',
//         'Origin, X-Requested-With, Content-Type, Accept',
//     );
//     res.header('Access-Control-Allow-Origin', '*');
//     next();
// });

// Routes
app.get('/', (req, res) => res.send('Vyre Backend!'));
app.use('/api/v1', router);
app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));

// initializeAdmin();

export default app;