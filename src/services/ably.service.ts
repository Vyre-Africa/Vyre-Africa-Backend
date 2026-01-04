import { Request, Response } from 'express';
import prisma from '../config/prisma.config';
import config from '../config/env.config';
import Ably from 'ably';


class AblyService
{

    private ably:any;
    private userChannel:any;
    private orderChannel:any;
    private storeChannel:any;
    private GeneralChannel:any;

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


    async awaiting_Order_Update(awaitingId:string)
    {
      const awaitingOrder = await prisma.awaiting.findUnique({
        where:{id: awaitingId}
      })

      this.ably = new Ably.Realtime("nECyrQ.Y6Twcg:Ao47kxy-2RK2df35GalolYCLEUwlYuhbASnKwUeFUiE")
      this.ably.connection.once("connected", () => {
        console.log("Connected to Ably!")
      })

      this.orderChannel = this.ably.channels.get("ORDER")

      await this.orderChannel.publish(awaitingId,awaitingOrder)
      // return 'done'
      return this.ably.connection.close();

    }
    

    async notifyUser(userId:string,title:string,body:string)
    {
      this.ably = new Ably.Realtime("nECyrQ.Y6Twcg:Ao47kxy-2RK2df35GalolYCLEUwlYuhbASnKwUeFUiE")
      this.ably.connection.once("connected", () => {
        console.log("Connected to Ably!")
      })

      this.userChannel = this.ably.channels.get("USERS")

      await this.userChannel.publish(userId,{title,body})
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


    async notifyGeneral(type:string,title:string,body:string)
    {
      this.ably = new Ably.Realtime("nECyrQ.Y6Twcg:Ao47kxy-2RK2df35GalolYCLEUwlYuhbASnKwUeFUiE")
      this.ably.connection.once("connected", () => {
        console.log("Connected to Ably!")
      })
      this.GeneralChannel = this.ably.channels.get("GENERAL")

      // ALL
      // SHOPPERS
      // MALLS

      await this.GeneralChannel.publish(type,{title,body})
      
      return this.ably.connection.close();
    }


    

    
  
}

export default new AblyService()