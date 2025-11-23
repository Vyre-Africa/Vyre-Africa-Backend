

type Network = 'ETHEREUM' | 'POLYGON' | 'ARBITRUM' | 'OPTIMISM' | 'BASE' | 'BSC' | 'TRON';

interface NetworkConfig {
  base: number;
  max: number;
  minWithdrawal: number;
  description: string;
}

class TransferfeeService {
  private gasBuffer = 1.5; // 50% buffer for gas fluctuations
  private serviceFee = 0.50; // Small service fee

   // Network-specific base fees in USD
  private networkBaseFees: Record<Network, NetworkConfig> = {
    'ETHEREUM': { 
      base: 2, 
      max: 15,
      minWithdrawal: 2,
      description: "High gas network"
    },
    'POLYGON': { 
      base: 0.5, 
      max: 1,
      minWithdrawal: 2,
      description: "Low cost network"
    },
    'ARBITRUM': { 
      base: 1, 
      max: 3,
      minWithdrawal: 2,
      description: "Optimistic rollup"
    },
    'OPTIMISM': { 
      base: 1, 
      max: 3,
      minWithdrawal: 2,
      description: "Optimistic rollup"
    },
    'BASE': { 
      base: 1, 
      max: 2,
      minWithdrawal: 2,
      description: "Coinbase L2"
    },
    'BSC': { 
      base: 0.8, 
      max: 1.5,
      minWithdrawal: 2,
      description: "Binance chain"
    },
    'TRON': { 
      base: 1, 
      max: 2,
      minWithdrawal: 2,
      description: "Energy-based fees"
    }
  };


  calculateFee(network: Network): number {
    // Validate network exists
    if (!this.networkBaseFees[network]) {
      throw new Error(`Unsupported network: ${network}`);
    }
    
    const networkConfig = this.networkBaseFees[network];
    const calculatedFee = networkConfig.base
    
    // Return the smaller of calculated fee or maximum allowed fee
    return Math.min(calculatedFee, networkConfig.max);
  }

  // Get minimum withdrawal amount for a network
  getMinimumWithdrawal(network: Network): number {
    if (!this.networkBaseFees[network]) {
      throw new Error(`Unsupported network: ${network}`);
    }
    return this.networkBaseFees[network].minWithdrawal;
  }

  // Check if withdrawal amount is sufficient
  isValidWithdrawal(network: Network, amount: number): boolean {
    return amount >= this.getMinimumWithdrawal(network);
  }
      
    
}

export default new TransferfeeService()