"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const zeptomail_1 = require("zeptomail");
// 13ef.77aaa135805f0ced.k1.ab90a2b0-5ae8-11ef-bb3a-525400b65433.191555d985b
// Qaya admin invitation for already users
// 13ef.77aaa135805f0ced.k1.b7ceebf0-5ab0-11ef-bb3a-525400b65433.19153eee82f
// Qaya admin invitation
// 13ef.77aaa135805f0ced.k1.dfac3b50-5ae2-11ef-bb3a-525400b65433.19155379b85
// qaya verification email
// 13ef.77aaa135805f0ced.k1.54dc33f0-5ae6-11ef-bb3a-525400b65433.191554e44af
// qaya verification otp
// 13ef.77aaa135805f0ced.k1.b01aae50-5dbf-11ef-bb3a-525400b65433.19167fa2db5
// organisation admin 
// 13ef.77aaa135805f0ced.k1.34b76770-5dc5-11ef-bb3a-525400b65433.191681e5767
// organisation admin invitation for already users
class MailService {
    constructor() {
        this.url = 'api.zeptomail.eu/v1.1/email/template';
        this.batchUrl = 'api.zeptomail.eu/v1.1/email/template/batch';
        // /v1.1/email/template
        // /v1.1/email/template/batch
        this.token = 'Zoho-enczapikey yA6KbHtS7A2lyz4BFBM015CL8Nw3pK46jSXksn/mfMMleNnmh6E9hhBod9C7LzuJ3NLStP9TbtwVId+xvItcf5UyY99ZJ5TGTuv4P2uV48xh8ciEYNYvhpSgALIVFqdKcx8hCi4yQfckWA==';
        this.client = new zeptomail_1.SendMailClient({ url: this.url, token: this.token });
        this.batchClient = new zeptomail_1.SendMailClient({ url: this.batchUrl, token: this.token });
    }
    async general(address, userName, title, content) {
        try {
            const response = await this.client.sendMail({
                mail_template_key: '13ef.77aaa135805f0ced.k1.d7473860-437c-11f0-832a-66e0c45c7bae.19749980ee6',
                from: {
                    address: 'team@vyre.africa',
                    name: 'Vyre',
                },
                to: [
                    {
                        email_address: {
                            address: address,
                            name: 'Vyre',
                        },
                    },
                ],
                merge_info: {
                    title,
                    content,
                    user_name: userName
                },
                subject: title,
            });
            console.log('success', response);
        }
        catch (error) {
            console.error('error', error);
        }
    }
    async order_Placed(address, userName, amount, status, reference) {
        // console.log('address',address,'userName',userName,'otp',otp)
        try {
            const response = await this.client.sendMail({
                mail_template_key: '13ef.77aaa135805f0ced.k1.b1f19160-cc1a-11f0-90c5-e23f717f7d6f.19ac8ecb576',
                from: {
                    address: 'team@vyre.africa',
                    name: 'Vyre',
                },
                to: [
                    {
                        email_address: {
                            address: address,
                            name: 'Vyre',
                        },
                    },
                ],
                merge_info: {
                    date: Date.now(),
                    user_name: userName,
                    amount,
                    status,
                    reference
                },
                subject: 'Order created',
            });
            console.log('success', response);
        }
        catch (error) {
            console.error('error', error);
        }
    }
    async sendBroadCast(receipients) {
        this.batchClient.mailBatchWithTemplate({
            mail_template_key: '2d6f.26d5e25050d88a1b.k1.6022cd80-71a9-11ef-9659-525400fa05f6.191ea7a6258',
            from: {
                address: 'noreply@helloqaya.com',
                name: 'Kevwe from Qaya',
            },
            to: receipients,
        }).then((resp) => console.log("success", resp, resp.details)).catch((error) => console.log("error", error));
    }
    async sendMail(address, value) {
        try {
            const response = await this.client.sendMail({
                mail_template_key: '13ef.77aaa135805f0ced.k1.f5a87620-23ac-11ef-b963-525400b65433.18feb639682',
                from: {
                    address: 'noreply@vyre.africa',
                    name: 'noreply',
                },
                to: [
                    {
                        email_address: {
                            address: address,
                            name: 'Qaya',
                        },
                    },
                ],
                merge_info: { Pin: value },
                subject: 'OTP Verify',
            });
            console.log('success', response);
        }
        catch (error) {
            console.error('error', error);
        }
    }
    // public async sendOtp(address:string, userName:string, otp: string): Promise<void> {
    //     try {
    //         const response = await this.client.sendMail({
    //             mail_template_key:
    //                 '2d6f.26d5e25050d88a1b.k1.a43bcf30-7edd-11ef-bd93-525400f92481.19241034ba3',
    //             from: {
    //                 address: 'noreply@helloqaya.com',
    //                 name: 'noreply',
    //             },
    //             to: [
    //                 {
    //                     email_address: {
    //                         address: address,
    //                         name: 'Qaya',
    //                     },
    //                 },
    //             ],
    //             merge_info: { 
    //                 otp: otp, 
    //                 user_name: userName 
    //             },
    //             subject: 'Verify Account',
    //         });
    //         console.log('success', response);
    //     } catch (error) {
    //         console.error('error', error);
    //     }
    // }
    async sendOtp(address, userName, otp) {
        console.log('address', address, 'userName', userName, 'otp', otp);
        try {
            const response = await this.client.sendMail({
                mail_template_key: '13ef.77aaa135805f0ced.k1.0cd756f0-c1c2-11ef-9408-7273078ee4fb.193f765d1df',
                from: {
                    address: 'noreply@vyre.africa',
                    name: 'noreply',
                },
                to: [
                    {
                        email_address: {
                            address: address,
                            name: 'Vyre',
                        },
                    },
                ],
                merge_info: {
                    Pin: otp,
                    user_name: userName
                },
                subject: 'Verify Account',
            });
            console.log('success', response);
        }
        catch (error) {
            console.error('error', error);
        }
    }
    async sendWelcomeEmail(address, userName) {
        console.log('address', address, 'userName', userName);
        try {
            const response = await this.client.sendMail({
                mail_template_key: '13ef.77aaa135805f0ced.k1.d7473860-437c-11f0-832a-66e0c45c7bae.19749980ee6',
                from: {
                    address: 'noreply@vyre.africa',
                    name: 'noreply',
                },
                to: [
                    {
                        email_address: {
                            address: address,
                            name: 'Vyre',
                        },
                    },
                ],
                merge_info: {
                    user_name: userName
                },
                subject: 'Welcome to Vyre – Your Account is Fully Verified! 🎉',
            });
            console.log('success', response);
        }
        catch (error) {
            console.error('error', error);
        }
    }
    async sendVerificationLink(address, userName, url) {
        try {
            const response = await this.client.sendMail({
                mail_template_key: '2d6f.26d5e25050d88a1b.k1.06833c21-7ee1-11ef-bd93-525400f92481.192411978e2',
                from: {
                    address: 'noreply@helloqaya.com',
                    name: 'noreply',
                },
                to: [
                    {
                        email_address: {
                            address: address,
                            name: 'Qaya',
                        },
                    },
                ],
                merge_info: {
                    verify_account_link: url,
                    user_name: userName
                },
                subject: 'Verify Account',
            });
            console.log('success', response);
        }
        catch (error) {
            console.error('error', error);
        }
    }
    //   Store Invitation with access details
    async sendInvitationWithDetails(address, userName, user_password, store_name, organisation_name, accept_link) {
        try {
            const response = await this.client.sendMail({
                mail_template_key: '2d6f.26d5e25050d88a1b.k1.72a884c0-7f07-11ef-bd93-525400f92481.1924215470c',
                from: {
                    address: 'noreply@helloqaya.com',
                    name: 'noreply',
                },
                to: [
                    {
                        email_address: {
                            address: address,
                            name: 'Qaya',
                        },
                    },
                ],
                merge_info: {
                    user_password: user_password,
                    store_name: store_name,
                    organisation_name: organisation_name,
                    accept_link: accept_link,
                    user_name: userName
                },
                subject: 'Qaya Admin',
            });
            console.log('success', response);
        }
        catch (error) {
            console.error('error', error);
        }
    }
    // Store invitation without access details
    async sendInvitation(address, userName, store_name, organisation_name, accept_link) {
        try {
            const response = await this.client.sendMail({
                mail_template_key: '2d6f.26d5e25050d88a1b.k1.34312050-7f0a-11ef-bd93-525400f92481.192422756d5',
                from: {
                    address: 'noreply@helloqaya.com',
                    name: 'noreply',
                },
                to: [
                    {
                        email_address: {
                            address: address,
                            name: 'Qaya',
                        },
                    },
                ],
                merge_info: {
                    store_name: store_name,
                    organisation_name: organisation_name,
                    accept_link: accept_link,
                    user_name: userName
                },
                subject: 'Qaya Admin',
            });
            console.log('success', response);
        }
        catch (error) {
            console.error('error', error);
        }
    }
    // Organisation Admin invitaion with details
    async sendAdminInvitationWithDetails(address, userName, user_password, organisation_name, accept_link) {
        try {
            const response = await this.client.sendMail({
                mail_template_key: '2d6f.26d5e25050d88a1b.k1.e262ac60-7f0b-11ef-bd93-525400f92481.19242325a26',
                from: {
                    address: 'noreply@helloqaya.com',
                    name: 'noreply',
                },
                to: [
                    {
                        email_address: {
                            address: address,
                            name: 'Qaya',
                        },
                    },
                ],
                merge_info: {
                    user_password: user_password,
                    organisation_name: organisation_name,
                    accept_link: accept_link,
                    user_name: userName
                },
                subject: 'Qaya Admin',
            });
            console.log('success', response);
        }
        catch (error) {
            console.error('error', error);
        }
    }
    // Organisation Admin invitation without details
    async sendAdminInvitation(address, userName, organisation_name, accept_link) {
        try {
            const response = await this.client.sendMail({
                mail_template_key: '2d6f.26d5e25050d88a1b.k1.1a2ca2d0-7f0d-11ef-bd93-525400f92481.192423a557d',
                from: {
                    address: 'noreply@helloqaya.com',
                    name: 'noreply',
                },
                to: [
                    {
                        email_address: {
                            address: address,
                            name: 'Qaya',
                        },
                    },
                ],
                merge_info: {
                    organisation_name: organisation_name,
                    accept_link: accept_link,
                    user_name: userName
                },
                subject: 'Qaya Admin',
            });
            console.log('success', response);
        }
        catch (error) {
            console.error('error', error);
        }
    }
}
exports.default = new MailService();
