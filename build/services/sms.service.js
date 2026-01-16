"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const axios_1 = __importDefault(require("axios"));
const env_config_1 = __importDefault(require("../config/env.config"));
const termiiAxios = axios_1.default.create({
    baseURL: env_config_1.default.termiiBaseUrl,
});
class SMSService {
    constructor() {
        this.provider = 'termii';
    }
    async send(token, number) {
        const data = {
            api_key: env_config_1.default.termiiLiveKey,
            to: number,
            from: 'Vyre Africa',
            sms: `${token}`,
            type: 'plain',
            channel: 'whatsapp', //It is either dnd, whatsapp, or generic
        };
        return await termiiAxios.post('/api/sms/send', data);
    }
    async sendBulk(data) {
        // return await termiiAxios.get('https://v3.api.termii.com/api/sender-id?api_key=TLYnfZSxEmUgkZDHBRNosLsKyWLezfNJHkGJJcQAVxxJbWZCuuVOoELPsKIFSL')
        return await termiiAxios.post('/api/sms/send/bulk', data);
    }
}
exports.default = new SMSService();
