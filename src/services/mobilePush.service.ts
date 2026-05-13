import { Request, Response } from 'express';
import prisma from '../config/prisma.client';
import config from '../config/env.config';
import { Expo, ExpoPushMessage } from 'expo-server-sdk';

class MobilePushService
{

    private expo;

    constructor() {
        this.expo = new Expo({})    
    }

    async singlePush(title:string,body:string,token:string)
    {
      console.log(title,body,token)
      
        const message:ExpoPushMessage = { 
            to: token,
            sound: 'default',
            title: title,
            body: body,
            data: { withSome: 'data' },
        }

        let messages = []

        messages.push(message)

        await this.expo.sendPushNotificationsAsync(messages)
    }


    async BulkPush(title:string,body:string,pushTokens:string[])
    {

        let messages:ExpoPushMessage[] = [];
        for (let pushToken of pushTokens) {
          // Each push token looks like ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]
        
          // Check that all your push tokens appear to be valid Expo push tokens
          if (!Expo.isExpoPushToken(pushToken)) {
            console.error(`Push token ${pushToken} is not a valid Expo push token`);
            continue;
          }

          messages.push({
            to: pushToken,
            sound: 'default',
            title: title,
            body: body,
            data: { withSome: 'data' },
          })
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
            
            } catch (error) {
            console.error(error);
            }
        }
        })();

    }

    
  
}

export default new MobilePushService()