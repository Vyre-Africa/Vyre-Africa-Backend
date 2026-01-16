"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const dotenv_1 = __importDefault(require("dotenv"));
const cors_1 = __importDefault(require("cors"));
const body_parser_1 = __importDefault(require("body-parser"));
const compression_1 = __importDefault(require("compression"));
const cookie_parser_1 = __importDefault(require("cookie-parser"));
const morgan_1 = __importDefault(require("morgan"));
const swagger_ui_express_1 = __importDefault(require("swagger-ui-express"));
const swagger_output_json_1 = __importDefault(require("../swagger-output.json"));
const app = (0, express_1.default)();
const routes_1 = require("./routes");
dotenv_1.default.config();
// FOR WEBHOOK handler
app.use('/api/v1/webhook/fern', express_1.default.raw({ type: 'application/json', limit: '10mb' }));
app.use('/api/v1/webhook/clerk', express_1.default.raw({ type: 'application/json', limit: '10mb' }));
// app.use('/api/v1/tatum/events', express.raw({ type: 'application/json', limit: '10mb' }));
// app.use('/api/v1/webhook', express.raw({ type: 'application/json', limit: '10mb' }));
app.use(express_1.default.json({ limit: '10mb' }));
app.use(body_parser_1.default.urlencoded({ extended: true }));
app.get('/', (req, res) => res.send('Vyre Backend!'));
// initializeAdmin();
app.use((0, compression_1.default)());
app.use((0, morgan_1.default)('dev'));
app.use((0, cookie_parser_1.default)());
app.use(function (req, res, next) {
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    res.header('Access-Control-Allow-Origin', '*');
    next();
});
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
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
        'Origin',
        'X-Requested-With',
        'Content-Type',
        'Accept',
        'Authorization'
    ],
    credentials: true,
    optionsSuccessStatus: 200 // For legacy browsers
};
app.use((0, cors_1.default)(corsOptions));
app.use('/api/v1', routes_1.router);
app.use('/api/docs', swagger_ui_express_1.default.serve, swagger_ui_express_1.default.setup(swagger_output_json_1.default));
exports.default = app;
