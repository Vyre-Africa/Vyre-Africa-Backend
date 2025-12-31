import { Request, Response } from "express";
import prisma from "../config/prisma.config";
import Decimal from 'decimal.js';


export class DecimalUtil {
  private static TOLERANCE = new Decimal('0.00000001');

  static isEqual(a: number | string, b: number | string): boolean {
    const decimalA = new Decimal(a.toString());
    const decimalB = new Decimal(b.toString());
    return decimalA.minus(decimalB).abs().lessThan(this.TOLERANCE);
  }

  static isGreaterThan(a: number | string, b: number | string): boolean {
    const decimalA = new Decimal(a.toString());
    const decimalB = new Decimal(b.toString());
    return decimalA.greaterThan(decimalB);
  }

  static isLessThan(a: number | string, b: number | string): boolean {
    const decimalA = new Decimal(a.toString());
    const decimalB = new Decimal(b.toString());
    return decimalA.lessThan(decimalB);
  }

  static add(a: number | string, b: number | string): string {
    const decimalA = new Decimal(a.toString());
    const decimalB = new Decimal(b.toString());
    return decimalA.plus(decimalB).toString();
  }

  static subtract(a: number | string, b: number | string): string {
    const decimalA = new Decimal(a.toString());
    const decimalB = new Decimal(b.toString());
    return decimalA.minus(decimalB).toString();
  }
}
