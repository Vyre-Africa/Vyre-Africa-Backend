"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const prisma_config_1 = __importDefault(require("../../config/prisma.config"));
class AdminAdvertController {
    async fetchpublished(req, res) {
        const { limit, page } = req.query;
        try {
            const totalCount = await prisma_config_1.default.advert.count();
            const itemLimit = limit ? parseInt(limit) : 20;
            const totalPages = Math.ceil(totalCount / itemLimit);
            const currentPage = page ? Math.max(parseInt(page), 1) : 1;
            const skip = (currentPage - 1) * itemLimit;
            const adverts = await prisma_config_1.default.advert.findMany({
                skip: skip,
                take: itemLimit
            });
            console.log('Fetched adverts: ', adverts);
            return res
                .status(200)
                .json({
                msg: 'Successful',
                success: true,
                totalCount: totalCount,
                totalPages: totalPages,
                limit: itemLimit,
                currentPage: currentPage,
                adverts: adverts,
            });
        }
        catch (error) {
            console.log(error);
            return res.status(500).json({ msg: 'Something went wrong', error });
        }
    }
    async fetchDrafts(req, res) {
        const { limit, page } = req.query;
        try {
            const totalCount = await prisma_config_1.default.advertDraft.count();
            const itemLimit = limit ? parseInt(limit) : 20;
            const totalPages = Math.ceil(totalCount / itemLimit);
            const currentPage = page ? Math.max(parseInt(page), 1) : 1;
            const skip = (currentPage - 1) * itemLimit;
            const adverts = await prisma_config_1.default.advertDraft.findMany({
                skip: skip,
                take: itemLimit
            });
            console.log('Fetched adverts: ', adverts);
            return res
                .status(200)
                .json({
                msg: 'Successful',
                success: true,
                totalCount: totalCount,
                totalPages: totalPages,
                limit: itemLimit,
                currentPage: currentPage,
                adverts: adverts,
            });
        }
        catch (error) {
            console.log(error);
            return res.status(500).json({ msg: 'Something went wrong', error });
        }
    }
    async createAdvert(req, res) {
        const { title, imgUrl } = req.body;
        try {
            const advert = await prisma_config_1.default.advert.create({
                data: {
                    title: title,
                    imgUrl: imgUrl
                }
            });
            return res.status(200).send({
                success: true,
                msg: 'Advert created successfully',
                advert
            });
        }
        catch (error) {
            console.log(error);
            return res
                .status(500)
                .json({ msg: 'something went wrong, please try again', success: false, error });
        }
    }
    async createDraft(req, res) {
        const { title, imgUrl } = req.body;
        try {
            const advertDraft = await prisma_config_1.default.advertDraft.create({
                data: {
                    title: title,
                    imgUrl: imgUrl
                }
            });
            return res.status(200).send({
                success: true,
                msg: 'Draft created successfully',
                advert: advertDraft
            });
        }
        catch (error) {
            return res
                .status(500)
                .json({ msg: 'something went wrong, please try again', success: false, error });
        }
    }
    async update(req, res) {
        const { title, imgUrl, type } = req.body;
        const id = req.params.id;
        let updatedAdvert;
        try {
            switch (type) {
                case 'published':
                    await prisma_config_1.default.advert.update({
                        where: { id },
                        data: { title, imgUrl }
                    });
                    updatedAdvert = await prisma_config_1.default.advert.findUnique({
                        where: { id }
                    });
                    break;
                case 'draft':
                    await prisma_config_1.default.advertDraft.update({
                        where: { id },
                        data: { title, imgUrl }
                    });
                    updatedAdvert = await prisma_config_1.default.advertDraft.findUnique({
                        where: { id }
                    });
                    break;
                default:
                    return res.status(400).json({ msg: 'type is undefined', success: false });
            }
            return res.status(200).send({
                success: true,
                msg: 'Draft updated successfully',
                advert: updatedAdvert
            });
        }
        catch (error) {
            return res
                .status(500)
                .json({ msg: 'something went wrong, please try again', success: false, error });
        }
    }
    async delete(req, res) {
        const { type } = req.body;
        const id = req.params.id;
        try {
            switch (type) {
                case 'published':
                    await prisma_config_1.default.advert.delete({
                        where: { id },
                    });
                    break;
                case 'draft':
                    await prisma_config_1.default.advertDraft.delete({
                        where: { id },
                    });
                    break;
                default:
                    return res.status(400).json({ msg: 'type is undefined', success: false });
            }
            return res.status(200).send({
                success: true,
                msg: 'Draft deleted successfully',
            });
        }
        catch (error) {
            return res
                .status(500)
                .json({ msg: 'something went wrong, please try again', success: false, error });
        }
    }
}
exports.default = new AdminAdvertController();
