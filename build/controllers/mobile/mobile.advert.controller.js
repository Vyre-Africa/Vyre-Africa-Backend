"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const prisma_config_1 = __importDefault(require("../../config/prisma.config"));
class MobileAdvertController {
    async get(req, res) {
        try {
            const adverts = await prisma_config_1.default.advert.findMany();
            return res.status(201).json({
                msg: 'adverts fetched successfully',
                success: true,
                adverts
            });
        }
        catch (error) {
            console.log(error);
            return res
                .status(500)
                .json({ msg: 'Internal Server Error', success: false, error });
        }
    }
}
exports.default = new MobileAdvertController();
