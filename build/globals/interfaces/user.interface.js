"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.currency = void 0;
var currency;
(function (currency) {
    currency[currency["NGN"] = 0] = "NGN";
    currency[currency["USD"] = 1] = "USD";
    currency[currency["ETH"] = 2] = "ETH";
    currency[currency["BTC"] = 3] = "BTC";
    currency[currency["LTC"] = 4] = "LTC";
    currency[currency["TRON"] = 5] = "TRON";
    currency[currency["BNB"] = 6] = "BNB";
    currency[currency["XRP"] = 7] = "XRP";
    currency[currency["USDT_ETH"] = 8] = "USDT_ETH";
    currency[currency["USDT_TRON"] = 9] = "USDT_TRON";
    currency[currency["USDC"] = 10] = "USDC";
})(currency || (exports.currency = currency = {}));
