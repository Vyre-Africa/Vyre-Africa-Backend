// src/services/ably.service.ts
import prisma from '../config/prisma.client';
import config from '../config/env.config';
import Ably from 'ably';
import logger from '../config/logger';


class AblyService {
 
    private ably: Ably.Realtime;
    private userChannel: any;
    private orderChannel: any;
    private storeChannel: any;
    private GeneralChannel: any;
    private cardKycChannel: any; // NEW
 
    constructor() {
        this.ably = new Ably.Realtime(config.ABLY_API_KEY);
 
        this.ably.connection.once('connected', () => {
            logger.info('Connected to Ably!');
        });
 
        this.ably.connection.on('failed', (err: any) => {
            logger.error('Ably connection failed', err);
        });
 
        // ── Persistent channels — opened once, reused forever ──
        this.userChannel    = this.ably.channels.get('USERS');
        this.orderChannel   = this.ably.channels.get('ORDER');
        this.storeChannel   = this.ably.channels.get('STORES');
        this.GeneralChannel = this.ably.channels.get('GENERAL');
        this.cardKycChannel = this.ably.channels.get('CARD_KYC'); // NEW
    }
 
    // ── Push full awaiting/order record to ORDER channel ────
    async awaiting_Order_Update(awaitingId: string) {
        const awaitingOrder = await prisma.awaiting.findUnique({
            where: { id: awaitingId }
        });
 
        await this.orderChannel.publish(awaitingId, awaitingOrder);
        return awaitingOrder;
    }
 
    // ── Push notification to a specific user ─────────────────
    async notifyUser(userId: string, title: string, body: string) {
        await this.userChannel.publish(userId, { title, body });
    }
 
    // ── Push notification to a specific store/vendor ──────────
    async notifyStore(storeId: string, title: string, body: string) {
        await this.storeChannel.publish(storeId, { title, body });
    }
 
    // ── Broadcast general notification ───────────────────────
    async notifyGeneral(type: string, title: string, body: string) {
        // type e.g. ALL, SHOPPERS, MALLS, VENDORS
        await this.GeneralChannel.publish(type, { title, body });
    }
 
    // ── NEW — push Contro card KYC resolution to a specific user ──
    // Replaces polling for the "cardholder exists, program KYC pending"
    // stage — frontend subscribes on userId the same way it already does
    // for the ORDER channel's awaitingId.
    async notifyCardKycUpdate(userId: string, status: 'approved' | 'rejected') {
        await this.cardKycChannel.publish(userId, { status });
    }
}
 
export default new AblyService();