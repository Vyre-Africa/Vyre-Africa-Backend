"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const expo_server_sdk_1 = require("expo-server-sdk");
class MobilePushService {
    constructor() {
        this.expo = new expo_server_sdk_1.Expo({});
    }
    async singlePush(title, body, token) {
        console.log(title, body, token);
        const message = {
            to: token,
            sound: 'default',
            title: title,
            body: body,
            data: { withSome: 'data' },
        };
        let messages = [];
        messages.push(message);
        await this.expo.sendPushNotificationsAsync(messages);
    }
    async BulkPush(title, body, pushTokens) {
        let messages = [];
        for (let pushToken of pushTokens) {
            // Each push token looks like ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]
            // Check that all your push tokens appear to be valid Expo push tokens
            if (!expo_server_sdk_1.Expo.isExpoPushToken(pushToken)) {
                console.error(`Push token ${pushToken} is not a valid Expo push token`);
                continue;
            }
            messages.push({
                to: pushToken,
                sound: 'default',
                title: title,
                body: body,
                data: { withSome: 'data' },
            });
        }
        let chunks = this.expo.chunkPushNotifications(messages);
        let tickets = [];
        (async () => {
            // Send the chunks to the Expo push notification service. There are
            for (let chunk of chunks) {
                try {
                    let ticketChunk = await this.expo.sendPushNotificationsAsync(chunk);
                    console.log(ticketChunk);
                    tickets.push(...ticketChunk);
                }
                catch (error) {
                    console.error(error);
                }
            }
        })();
    }
}
exports.default = new MobilePushService();
