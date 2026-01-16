"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const prisma_config_1 = __importDefault(require("../config/prisma.config"));
const logger_1 = __importDefault(require("../config/logger"));
// const clerkClient = createClerkClient({ secretKey: config.clerk.SECRET_KEY })
class ClerkService {
    // async createUser(payload:{firstName:string;lastName:string;emailAddress:string;password:string;houseHoldId: string;})
    // {
    //     const {firstName, lastName, emailAddress, password, houseHoldId } = payload
    //     try {
    //         console.log('Attempting to create Clerk user with:', { firstName, lastName, emailAddress });
    //         console.log('Clerk Secret Key available:', !!config.clerk.SECRET_KEY);
    //         console.log('Clerk Secret Key prefix:', config.clerk.SECRET_KEY?.substring(0, 10));
    //         const result = await clerkClient.users.createUser({
    //             firstName,
    //             lastName,
    //             emailAddress: [emailAddress],
    //             password,
    //             skipPasswordChecks: true, // Skip breach detection for development
    //             skipPasswordRequirement: false,
    //             unsafeMetadata:{
    //               houseHoldId: houseHoldId
    //             }
    //         });
    //         console.log('Clerk user created successfully:', result.id);
    //         return result;
    //     } catch (error: any) {
    //         console.error('Clerk createUser error:', error);
    //         console.error('Clerk error details:', error.clerkError || error.errors);
    //         console.error('Error message:', error.message);
    //         console.error('Error status:', error.status);
    //         // Check for network-related errors
    //         if (error.message?.includes('fetch failed') || error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
    //             console.error('Network connectivity issue detected with Clerk API');
    //             const networkError = new Error('Network connectivity issue with Clerk API. Please check your internet connection and Clerk service status.');
    //             (networkError as any).clerkError = true;
    //             (networkError as any).clerkTraceId = error.clerkTraceId || '';
    //             (networkError as any).errors = [{
    //                 code: 'network_error',
    //                 message: 'Unable to connect to Clerk servers. This may be due to network issues or Clerk service downtime.'
    //             }];
    //             throw networkError;
    //         }
    //         // Provide more helpful error messages
    //         if (error.errors) {
    //             error.errors.forEach((err: any) => {
    //                 console.error(`Clerk validation error - ${err.code}: ${err.message}`);
    //             });
    //         }
    //         throw error;
    //     }
    // }
    async processEvent(evt) {
        const { id, type: eventType, ...data } = evt;
        try {
            logger_1.default.info('Processing webhook event', { eventId: id, eventType });
            if (eventType === 'user.created') {
                await this.handleUserCreated(evt.data);
            }
            else if (eventType === 'user.updated') {
                await this.handleUserUpdated(evt.data);
            }
            else if (eventType === 'user.deleted') {
                await this.handleUserDeleted(evt.data);
            }
            else {
                logger_1.default.info('Unhandled webhook event type', { eventType });
            }
            logger_1.default.info('Webhook event processed successfully', {
                eventId: id,
                eventType
            });
        }
        catch (error) {
            logger_1.default.error('Webhook event processing failed', {
                eventId: id,
                eventType,
                error: error.message,
                stack: error.stack
            });
            // Optionally: Queue for retry
            // await this.queueFailedWebhook(evt, error);
        }
    }
    async handleUserCreated(userData) {
        if (!userData?.email_addresses?.[0]?.email_address) {
            throw new Error('No email address in user.created event');
        }
        const emailAddress = userData.email_addresses[0].email_address;
        logger_1.default.info('Handling user.created', { email: emailAddress, clerkId: userData.id });
        // Check if user already exists
        const existingUser = await prisma_config_1.default.user.findUnique({
            where: { email: emailAddress },
            select: { id: true }
        });
        if (existingUser) {
            // Update existing user with Clerk ID
            await prisma_config_1.default.user.update({
                where: { id: existingUser.id },
                data: {
                    id: userData.id,
                    firstName: userData.first_name,
                    lastName: userData.last_name,
                    email: emailAddress,
                    emailVerified: userData.email_addresses[0]?.verification?.status === 'verified',
                    photoUrl: userData.profile_image_url
                }
            });
            logger_1.default.info('Existing user updated with Clerk data', {
                id: userData.id,
                clerkId: userData.id
            });
        }
        else {
            // Create new user
            const newUser = await prisma_config_1.default.user.create({
                data: {
                    id: userData.id,
                    firstName: userData.first_name,
                    lastName: userData.last_name,
                    email: emailAddress,
                    emailVerified: userData.email_addresses[0]?.verification?.status === 'verified',
                    photoUrl: userData.profile_image_url
                }
            });
            logger_1.default.info('New user created', {
                userId: newUser.id,
                clerkId: userData.id
            });
            // Optionally: Send welcome email, create default wallets, etc.
            // this.sendWelcomeEmail(newUser).catch(err => 
            //     logger.error('Failed to send welcome email', err)
            // );
        }
    }
    // ✅ Handle user.updated event
    async handleUserUpdated(userData) {
        if (!userData?.email_addresses?.[0]?.email_address) {
            throw new Error('No email address in user.updated event');
        }
        const emailAddress = userData.email_addresses[0].email_address;
        logger_1.default.info('Handling user.updated', { email: emailAddress, clerkId: userData.id });
        // Find user by Clerk ID or email
        const user = await prisma_config_1.default.user.findFirst({
            where: {
                OR: [
                    { id: userData.id },
                    { email: emailAddress }
                ]
            },
            select: { id: true }
        });
        if (!user) {
            logger_1.default.warn('User not found for update', {
                clerkId: userData.id,
                email: emailAddress
            });
            return;
        }
        // Update user
        await prisma_config_1.default.user.update({
            where: { id: user.id },
            data: {
                authId: userData.id,
                firstName: userData.first_name,
                lastName: userData.last_name,
                isDeactivated: userData.locked,
                email: emailAddress,
                emailVerified: userData.email_addresses[0]?.verification?.status === 'verified',
                photoUrl: userData.profile_image_url
            }
        });
        logger_1.default.info('User updated', { userId: user.id, clerkId: userData.id });
    }
    // ✅ Handle user.deleted event (optional)
    async handleUserDeleted(userData) {
        logger_1.default.info('Handling user.deleted', { clerkId: userData.id });
        const user = await prisma_config_1.default.user.findUnique({
            where: { id: userData.id },
            select: { id: true }
        });
        if (!user) {
            logger_1.default.warn('User not found for deletion', { clerkId: userData.id });
            return;
        }
        // Soft delete or mark as deactivated
        await prisma_config_1.default.user.update({
            where: { id: user.id },
            data: {
                isDeactivated: true,
                deactivationReason: 'Account deleted from Clerk'
            }
        });
        logger_1.default.info('User deactivated', { userId: user.id, clerkId: userData.id });
    }
}
exports.default = new ClerkService();
