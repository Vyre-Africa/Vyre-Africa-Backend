"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.adminBase = exports.initializeAdmin = void 0;
const firebase_admin_1 = __importDefault(require("firebase-admin"));
const serviceAccountKey_json_1 = __importDefault(require("../../serviceAccountKey.json"));
let adminBase;
const initializeAdmin = () => {
    try {
        exports.adminBase = adminBase = firebase_admin_1.default.initializeApp({
            credential: firebase_admin_1.default.credential.cert(serviceAccountKey_json_1.default),
        });
        return adminBase;
    }
    catch (error) {
        console.log(error);
    }
};
exports.initializeAdmin = initializeAdmin;
