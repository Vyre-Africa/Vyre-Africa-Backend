import { body } from 'express-validator';

class OrderValidator {
  createOrder() {
    return [
      // body('price')
      //   .notEmpty()
      //   .withMessage('Price is required')
      //   .isFloat()
      //   .withMessage('Invalid price'),
        // body('cartId').notEmpty().withMessage('Cart ID is required'),
      // body('products').isArray(),
      // body('products.*.name')
      //   .notEmpty()
      //   .withMessage('Product name is required'),
      // body('products.*.cart_Quantity')
      //   .notEmpty()
      //   .withMessage('Product quantity is required')
      //   .isInt({ min: 1 })
      //   .withMessage('Invalid quantity. Must be a positive integer'),
      // body('products.*.price')
      //   .notEmpty()
      //   .withMessage('Product price is required')
      //   .isFloat()
      //   .withMessage('Invalid product price'),
      // body('products.*.SKU').notEmpty().withMessage('Product SKU is required'),
      body('price').notEmpty().withMessage('price is required'),
      body('amount').notEmpty().withMessage('order amount is required'),
      body('type').notEmpty().withMessage('order type is required'),
      body('pairId').notEmpty().withMessage('pairId is required'),
    ];
  }

  initializeAnon() {
    return [
      body('amount').notEmpty().withMessage('Amount is required').isFloat().withMessage('Invalid amount'),
    
      body('user').isObject().withMessage('User must be an object'),
          body('user.firstName').notEmpty().withMessage('first name is required'),
          body('user.lastName').notEmpty().withMessage('last name is required'),
          body('user.phoneNumber').notEmpty().withMessage('phone number is required'),
          body('user.email').notEmpty().withMessage('user email is required').isEmail().withMessage('user email is invalid'),
          body('user.pin').notEmpty().withMessage('user pin is required'),

      body('orderId').notEmpty().withMessage('order ID is required').isString().withMessage('order Id is invalid'),
      body('currencyId').notEmpty().withMessage('currency ID is required').isString().withMessage('currency Id is invalid'),
      

      // user bank details
      body('bank').isObject().optional(),
          body('bank.accountNumber').optional(),
          body('bank.bankCode').optional(),
          body('bank.recipient').optional(),
          
      // user crypto wallet details
      body('crypto').isObject().optional(),
          body('crypto.address').optional()

    ];
  }

  processOrder() {
    return [
      body('amount').notEmpty().withMessage('amount is required'),
      body('orderId').notEmpty().withMessage('orderId is required')
    ];
  }
}

export default new OrderValidator();
