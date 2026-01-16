"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const prisma_config_1 = __importDefault(require("../config/prisma.config"));
const ably_1 = __importDefault(require("ably"));
class AblyService {
    // constructor() {
    //   this.ably = new Ably.Realtime("nECyrQ.Y6Twcg:Ao47kxy-2RK2df35GalolYCLEUwlYuhbASnKwUeFUiE")
    //   this.ably.connection.once("connected", () => {
    //     console.log("Connected to Ably!")
    //   })
    //   this.userChannel = this.ably.channels.get("USERS")
    //   this.storeChannel = this.ably.channels.get("STORES")
    //   this.GeneralChannel = this.ably.channels.get("GENERAL")
    //   return
    // }
    async awaiting_Order_Update(awaitingId) {
        const awaitingOrder = await prisma_config_1.default.awaiting.findUnique({
            where: { id: awaitingId }
        });
        this.ably = new ably_1.default.Realtime("nECyrQ.Y6Twcg:Ao47kxy-2RK2df35GalolYCLEUwlYuhbASnKwUeFUiE");
        this.ably.connection.once("connected", () => {
            console.log("Connected to Ably!");
        });
        this.orderChannel = this.ably.channels.get("ORDER");
        await this.orderChannel.publish(awaitingId, awaitingOrder);
        // return 'done'
        return this.ably.connection.close();
    }
    async notifyUser(userId, title, body) {
        this.ably = new ably_1.default.Realtime("nECyrQ.Y6Twcg:Ao47kxy-2RK2df35GalolYCLEUwlYuhbASnKwUeFUiE");
        this.ably.connection.once("connected", () => {
            console.log("Connected to Ably!");
        });
        this.userChannel = this.ably.channels.get("USERS");
        await this.userChannel.publish(userId, { title, body });
        // return 'done'
        return this.ably.connection.close();
    }
    // async notifyStore(storeId:string,title:string,body:string)
    // {
    //   this.ably = new Ably.Realtime("nECyrQ.Y6Twcg:Ao47kxy-2RK2df35GalolYCLEUwlYuhbASnKwUeFUiE")
    //   this.ably.connection.once("connected", () => {
    //     console.log("Connected to Ably!")
    //   })
    //   this.storeChannel = this.ably.channels.get("STORES")
    //   await this.storeChannel.publish(storeId,{title,body})
    //   return this.ably.connection.close();
    // }
    async notifyGeneral(type, title, body) {
        this.ably = new ably_1.default.Realtime("nECyrQ.Y6Twcg:Ao47kxy-2RK2df35GalolYCLEUwlYuhbASnKwUeFUiE");
        this.ably.connection.once("connected", () => {
            console.log("Connected to Ably!");
        });
        this.GeneralChannel = this.ably.channels.get("GENERAL");
        // ALL
        // SHOPPERS
        // MALLS
        await this.GeneralChannel.publish(type, { title, body });
        return this.ably.connection.close();
    }
}
exports.default = new AblyService();
