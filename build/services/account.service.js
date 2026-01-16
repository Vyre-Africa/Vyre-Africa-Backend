"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const prisma_config_1 = __importDefault(require("../config/prisma.config"));
class AccountService {
    async deleteAccountById(accountId) {
        try {
            // First try to delete from fiat accounts
            const deletedFiatAccount = await prisma_config_1.default.fiatAccount.deleteMany({
                where: {
                    id: accountId
                }
            });
            // If a fiat account was deleted, return true
            if (deletedFiatAccount.count > 0) {
                return true;
            }
            // If no fiat account was found, try crypto accounts
            const deletedCryptoAccount = await prisma_config_1.default.cryptoAccount.deleteMany({
                where: {
                    id: accountId
                }
            });
            // Return true if a crypto account was deleted
            return deletedCryptoAccount.count > 0;
        }
        catch (error) {
            console.error('Error deleting account:', error);
            return false;
        }
    }
}
exports.default = new AccountService();
