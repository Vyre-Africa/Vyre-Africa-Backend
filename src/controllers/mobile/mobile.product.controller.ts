import { Request, Response } from 'express';
import prisma from '../../config/prisma.client';
import { endOfDay, startOfDay, subHours } from 'date-fns';
// import productService from '../../services/product.service';
import { create } from 'qrcode';

class MobileProductController {
    // async fetchProductsbyKeyword(req: Request | any, res: Response) {
    //     const { limit, storeId, search } = req.query;

    //     if (!storeId) {
    //         return res.status(400).json({ msg: 'store required', success: false });
    //     }

    //     if (!search) {
    //         return res.status(400).json({ msg: 'keyword required', success: false });
    //     }


    //     try {
    //         const products = await prisma.product.findMany({
    //             where: {
    //                 storeId,
    //                 status: 'PUBLISHED',
    //                 name: {
    //                     contains: search,
    //                     mode: 'insensitive'
    //                 }
    //             },
    //             include: {
    //                 images: true
    //             },
    //             take: limit ? parseInt(limit as string) : 10,
    //             orderBy: { createdAt: "desc" }
    //         });

    //         //increase search count for products
    //         products.forEach(async product => {
    //             await prisma.product.update({
    //                 where: { id: product.id },
    //                 data: { searchCount: product.searchCount + 1 }
    //             })
    //         })

    //         return res
    //             .status(200)
    //             .json({
    //                 msg: 'Successful',
    //                 success: true,
    //                 limit: limit,
    //                 products: products,
    //             });

    //     } catch (error) {
    //         console.error(error);
    //         return res.status(500).send({ msg: 'Internal Server Error', success: false, error });
    //     }
    // }

    // async fetchCategories(req: Request | any, res: Response) {
    //     const { limit, storeId } = req.query;

    //     if (!storeId) {
    //         return res.status(400).json({ msg: 'store required', success: false });
    //     }

    //     try {
    //         const categories = await prisma.category.findMany({
    //             where: { storeId },
    //             include: {
    //                 subCategories: {
    //                     include: { products: true }
    //                 }
    //             }
    //         })

    //         return res
    //             .status(200)
    //             .json({
    //                 msg: 'Successful',
    //                 success: true,
    //                 categories
    //             });

    //     } catch (error) {
    //         console.error(error);
    //         return res.status(500).send({ msg: 'Internal Server Error', success: false, error });
    //     }
    // }

    // async filterProducts(req: Request | any, res: Response) {
    //     const { limit, storeId, category, date_from, date_to, min_price, max_price } = req.query;

    //     if (!storeId) {
    //         return res.status(400).json({ msg: 'store required', success: false });
    //     }

    //     try {

    //         let dateFrom: Date | null = null;
    //         let dateTo: Date | null = null;

    //         if (date_from && date_to) {
    //             dateFrom = new Date(date_from as string);
    //             dateTo = new Date(date_to as string);
    //         }

    //         const products = await productService.filterProducts(
    //             storeId,
    //             limit,
    //             dateFrom,
    //             dateTo,
    //             category as string,
    //             parseInt(min_price),
    //             parseInt(max_price)
    //         );

    //         return res
    //             .status(200)
    //             .json({
    //                 msg: 'Successful',
    //                 success: true,
    //                 products
    //             });

    //     } catch (error) {
    //         console.error(error);
    //         return res.status(500).send({ msg: 'Internal Server Error', success: false, error });
    //     }
    // }

    // async getPopularProducts(req: Request | any, res: Response) {
    //     const { limit, storeId } = req.query;

    //     if (!storeId) {
    //         return res.status(400).json({ msg: 'store required', success: false });
    //     }

    //     try {
    //         const products = await prisma.product.findMany({
    //             where: {
    //                 storeId,
    //                 status: 'PUBLISHED',
    //             },
    //             include: {
    //                 images: true
    //             },
    //             take: limit ? parseInt(limit as string) : 5,
    //             orderBy: { searchCount: "desc" }
    //         });

    //         return res
    //             .status(200)
    //             .json({
    //                 msg: 'Successful',
    //                 success: true,
    //                 limit: limit,
    //                 products: products,
    //             });

    //     } catch (error) {
    //         console.error(error);
    //         return res.status(500).send({ msg: 'Internal Server Error', success: false, error });
    //     }
    // }

    // async submitReview(req: Request & Record<string, any>, res: Response) {
    //     const user = req.user
    //     const { rating, feedback } = req.body
    //     const productId = req.params.id

    //     try {

    //         //check if user has already reviewed the product
    //         const existingReview = await prisma.productReview.findFirst({
    //             where: {
    //                 userId: user.id,
    //                 productId
    //             }
    //         })

    //         if (existingReview) {
    //             return res.status(400).json({
    //                 msg: 'You have already submitted a review for this product',
    //                 success: false,
    //             });
    //         }

    //         const review = await prisma.productReview.create({
    //             data: {
    //                 userId: user.id,
    //                 productId,
    //                 rating,
    //                 feedback
    //             },
    //             include: { product: true }
    //         })

    //         return res.status(201).json({
    //             msg: 'Review submitted successfully',
    //             success: true,
    //             review
    //         });

    //     } catch (error) {
    //         console.log(error)
    //         return res
    //             .status(500)
    //             .json({ msg: 'Internal Server Error', success: false, error });
    //     }
    // }

    // async getReviews(req: Request, res: Response) {
    //     const productId = req.params.id as string
    //     const { limit } = req.query

    //     if (!productId) {
    //         return res.status(400).send('Product id required');
    //     }

    //     try {
    //         const reviews = await prisma.productReview.findMany({
    //             where: { productId },
    //             orderBy: { createdAt: 'desc' },
    //             include: {
    //                 product: true,
    //                 user: true
    //             },
    //             take: parseInt(limit as string) || 20,
    //         })

    //         const reviewAggregate = await prisma.productReview.aggregate({
    //             where: { productId },
    //             _count: true,
    //             _avg: { rating: true },
    //         })

    //         return res
    //             .status(200)
    //             .json({
    //                 msg: 'Successful',
    //                 success: true,
    //                 reviews,
    //                 totalReviews: reviewAggregate._count,
    //                 averageRating: reviewAggregate._avg.rating
    //             });
    //     } catch (error) {
    //         console.log(error);
    //         res.status(500).send(error);
    //     }
    // }

    // async getProductsToReview(req: Request, res: Response){
    //     const now = new Date()
    //     const twentyFourHoursAgo = subHours(now, 24)
    //     let productsToReview:any = [];

    //     try {
    //         const order = await prisma.order.findFirst({
    //             where: {
    //                 Status: 'PAID', 
    //                 updatedAt: {
    //                     lt: twentyFourHoursAgo
    //                 }
    //             },
    //             orderBy: { createdAt: 'desc' },
    //             include: {
    //                 products: true,
    //             },
    //         })

    //         if(order){
    //             order.products.forEach(async orderProduct => {
    //                 const review = await prisma.productReview.findFirst({
    //                     where: {
    //                         userId: order.userId,
    //                         productId: orderProduct.productId ?? ''
    //                     }
    //                 })

    //                 if(!review){
    //                     productsToReview.push(orderProduct)
    //                 }
    //             });
    //         }

    //         return res
    //             .status(200)
    //             .json({
    //                 msg: 'Successful',
    //                 success: true,
    //                 productsToReview
    //             });
    //     } catch (error) {
    //         console.log(error);
    //         res.status(500).send(error);
    //     }
    // }

    // async addToCart(req: Request & Record<string, any>, res: Response){
    //     const user = req.user
    //     const { product} = req.body

    //     console.log('this is the product',product)
    //     let cart:any

    //     try {
            
    //         //check if user already has a cart
    //         cart = await prisma.cart.findUnique({
    //             where: { userId: user.id },
    //             include: {
    //                 products: {
    //                   where: { storeId: product.storeId }, // Added for only the storeId
    //                   include: { product: true }
    //                 }
    //             }
    //         })

    //         if(cart){
    //             await prisma.cartProduct.create({
    //                 data: {
    //                   cartId: cart.id,
    //                   productId: product.id,
    //                   storeId: product.storeId,
    //                   images: product.images,
    //                   name: product.name,
    //                   quantity: product.quantity,
    //                   variants: {
    //                     create: product.variants.map((variant: any) => ({
    //                       name: variant.name,
    //                       value: variant.value,
    //                       price: variant.price ?? 0
    //                     })),
    //                   }
    //                 },
    //               });
    //             // cart = await prisma.cart.update({
    //             //     where: { id: cart.id },
    //             //     data: {total},
    //             //     include: {
    //             //         products: {
    //             //           where: { storeId: product.storeId }, // Added for only the storeId
    //             //           include: { product: true }
    //             //         }
    //             //     }
    //             // })
    //         }else{
    //             cart = await prisma.cart.create({
    //                 data: {
    //                     userId: user.id,
    //                     products: {
    //                         create: {
    //                             productId: product.id,
    //                             quantity: product.quantity,
    //                             storeId: product.storeId,
    //                             images: product.images,
    //                             name: product.name,
    //                             variants: {
    //                                 create: product.variants.map((variant: any) => ({
    //                                   name: variant.name,
    //                                   value: variant.value,
    //                                   price: variant.price ?? 0
    //                                 })),
    //                             }
    //                         }
    //                     }
    //                 },
    //                 include: {
    //                     products: {
    //                       where: { storeId: product.storeId }, // Added for only the storeId
    //                       include: { product: true }
    //                     }
    //                 }
    //             })
    //         }

    //         let cartTotal = 0;

    //             cart.products.forEach((cartProduct: any) => { 
    //                 console.log('cart product',cartProduct)
    //                 let variantsPrice = 0;
    //                 if(cartProduct.variants && cartProduct.variants.length) {
    //                     variantsPrice = cartProduct.variants.reduce((acc: number, variant: any) => acc + variant.price, 0);
    //                 }

    //                 cartTotal += (cartProduct.product.price + variantsPrice) * cartProduct.quantity;
    //             });


    //         return res
    //         .status(200)
    //         .json({
    //             msg: 'Successful',
    //             success: true,
    //             cart,
    //             cartTotal
    //         });

    //     } catch (error) {
    //         console.log(error);
    //         res.status(500).json({msg: 'Error adding to cart', success: false});
    //     }
    // }

    // async increaseProductQuantity(req: Request & Record<string, any>, res: Response){
    //     const user = req.user
    //     const { product} = req.body

    //     console.log('this is the product',product)
    //     let cart:any

    //     try {
            
    //         //check if user already has a cart
    //         cart = await prisma.cart.findUnique({
    //             where: { userId: user.id },
    //             include: {
    //                 products: {
    //                   where: { storeId: product.storeId }, // Added for only the storeId
    //                   include: { product: true }
    //                 }
    //             }
    //         })

    //         if(cart){
    //             await prisma.cartProduct.update({
    //                 where: {
    //                   id: product.id
    //                 },
    //                 data: {
    //                   quantity: { increment: 1 },
    //                 }
    //             });

    //         }

    //         const updatedCart = await prisma.cart.findUnique({
    //             where: { userId: user.id },
    //             include: {
    //                 products: {
    //                   where: { storeId: product.storeId }, // Added for only the storeId
    //                   include: { product: true }
    //                 }
    //             }
    //         })


    //         let cartTotal = 0;

    //         if(updatedCart){
    //             updatedCart.products.forEach((cartProduct: any) => {
    //                 let variantsPrice = 0;
    //                 if (cartProduct.variants && cartProduct.variants.length) {
    //                     variantsPrice = cartProduct.variants.reduce((acc: number, variant: any) => acc + variant.price, 0);
    //                 }
    //                 cartTotal += (cartProduct.product.price + variantsPrice) * cartProduct.quantity;
    //             });

    //         }

    //         return res
    //         .status(200)
    //         .json({
    //             msg: 'Successful',
    //             success: true,
    //             cart:updatedCart,
    //             cartTotal
    //         });

    //     } catch (error) {
    //         console.log(error);
    //         res.status(500).json({msg: 'Error adding to cart', success: false});
    //     }
    // }

    // async removeFromCart(req: Request & Record<string, any>, res: Response){
    //     const user = req.user
    //     const { product } = req.body

    //     try {
            
    //         const cart = await prisma.cart.findUnique({
    //             where: { userId: user.id },
    //             include: { products: true }
    //         })

    //         if(cart){
    //             await prisma.cartProduct.delete({
    //                 where: {
    //                   id: product.id,
    //                 },
    //             });
    //         }


    //         const updatedCart = await prisma.cart.findUnique({
    //             where: { userId: user.id },
    //             include: {
    //                 products: {
    //                   where: { storeId: product.storeId }, // Added for only the storeId
    //                   include: { product: true }
    //                 }
    //             }
    //         })

    //         let cartTotal = 0;

    //         if(updatedCart){
    //             updatedCart.products.forEach((cartProduct: any) => {
    //                 let variantsPrice = 0;
    //                 if (cartProduct.variants && cartProduct.variants.length) {
    //                     variantsPrice = cartProduct.variants.reduce((acc: number, variant: any) => acc + variant.price, 0);
    //                 }
    //                 cartTotal += (cartProduct.product.price + variantsPrice) * cartProduct.quantity;
    //             });

    //         }

            
    //         return res
    //             .status(200)
    //             .json({
    //                 msg: 'Successful',
    //                 success: true,
    //                 cart: updatedCart,
    //                 cartTotal
    //         });

            
    //     } catch (error) {
    //         console.log(error);
    //         res.status(500).json({msg: 'Error removing from cart', success: false});
    //     }
    // }

    // async reduceCartProduct(req: Request & Record<string, any>, res: Response){
    //     const user = req.user
    //     const { product } = req.body
    //     try {
            
    //         const userCart = await prisma.cart.findUnique({
    //             where: { userId: user.id },
    //             include: { products: true }
    //         })

    //         if(userCart){

    //             if(product.quantity === 1){

    //                 await prisma.cartProduct.delete({
    //                     where: {
    //                       id: product.id,
    //                     },
    //                 });

    //             }else{
    //                await prisma.cartProduct.update({
    //                     where: {
    //                       id: product.id,
    //                     },
    //                     data:{
    //                       quantity: product.quantity - 1
    //                     }
    //                 }); 
    //             }

    //         }

    //         const updatedCart = await prisma.cart.findUnique({
    //             where: { userId: user.id },
    //             include: {
    //                 products: {
    //                   where: { storeId: product.storeId }, // Added for only the storeId
    //                   include: { product: true }
    //                 }
    //             }
    //         })

    //         let cartTotal = 0;

    //         if(updatedCart){
    //             updatedCart.products.forEach((cartProduct: any) => {
    //                 let variantsPrice = 0;
    //                 if (cartProduct.variants && cartProduct.variants.length) {
    //                     variantsPrice = cartProduct.variants.reduce((acc: number, variant: any) => acc + variant.price, 0);
    //                 }
    //                 cartTotal += (cartProduct.product.price + variantsPrice) * cartProduct.quantity;
    //             });

    //         }
            
    //         console.log('Total cart price:', cartTotal);


    //         return res
    //             .status(200)
    //             .json({
    //              msg: 'Successful',
    //              success: true,
    //              cart: updatedCart,
    //              cartTotal
    //         });
    //     } catch (error) {
    //         console.log(error);
    //         res.status(500).json({msg: 'Error adding to cart', success: false});
    //     }
    // }

    // async getCart(req: Request & Record<string, any>, res: Response){
    //     const user = req.user
    //     const { storeId } = req.query
        
    //     let cartTotal:number = 0

    //     try {
            
    //         const cart = await prisma.cart.findUnique({
    //             where: { 
    //                 userId: user.id
    //             },
    //             include: {
    //                 products: {
    //                   where: { storeId: (storeId as string) }, // Added for only the storeId
    //                   include: { product: true, variants: true}
    //                 }
    //             }
    //         })

    //         if(!cart){
            
    //            return res
    //             .status(200)
    //             .json({
    //                 msg: 'Successful',
    //                 success: true,
    //                 products: [],
    //                 cartTotal:0
    //             });
    //         }


    //         if(cart.products.length){

    //             cart.products.forEach((cartProduct: any) => {
    //                 let variantsPrice = 0;
    //                 if(cartProduct.variants && cartProduct.variants.length) {
    //                     variantsPrice = cartProduct.variants.reduce((acc: number, variant: any) => acc + variant.price, 0);
    //                 }

    //                 cartTotal += (cartProduct.product.price + variantsPrice) * cartProduct.quantity;
    //             });
    //         }

    //         console.log('Total cart price:', cartTotal);


    //         return res
    //             .status(200)
    //             .json({
    //                 msg: 'Successful',
    //                 success: true,
    //                 products: cart.products,
    //                 cartTotal
    //         });
    //     } catch (error) {
    //         console.log(error);
    //         res.status(500).json({msg: 'Error getting cart', success: false});
    //     }
    // }
}

export default new MobileProductController()