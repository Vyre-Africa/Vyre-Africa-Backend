// scripts/poll-transfer-status.ts
//
//   npx ts-node --transpile-only -r dotenv/config scripts/poll-transfer-status.ts

import { getTransferStatus } from '../services/nuvion.service';

const TRANSFERS_TO_CHECK = [
    { label: 'Wire (Obiajulu)', id: '01M2654BKY7W0EPNPSGB3JE94F' },
    { label: 'GBP FPS (Obiajulu) — already known FAILED', id: '01M27BKP1XMVESTQ96TQ7DYEWW' },
];

async function main() {
    for (const { label, id } of TRANSFERS_TO_CHECK) {
        console.log(`\n=== ${label} (${id}) ===`);
        const result = await getTransferStatus(id);
        if (result.success) {
            console.log(`Status: ${result.status}`);
            console.log(`Full result:`, JSON.stringify(result, null, 2));
        } else {
            console.error(`❌ Failed to fetch:`, result.error);
        }
    }
}

main().catch((err) => console.error('Raw crash:', err));