// scripts/test-getAccount.ts
//
//   npx ts-node --transpile-only -r dotenv/config scripts/test-getAccount.ts

import { getAccount } from '../services/nuvion.service';

async function main() {
    const result = await getAccount('01M1W086TX52RXWD4RKVQA34DX');
    console.log('\n=== Full result ===');
    console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => console.error('Raw crash:', err));