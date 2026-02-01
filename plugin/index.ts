import { execFile } from 'child_process';
import { promisify } from 'util';
import { Type } from '@sinclair/typebox';
import WebSocket from 'ws';
import path from 'path';

const execFileAsync = promisify(execFile);

// Path to the overlay CLI script
const CLI_PATH = path.resolve(__dirname, '../skills/bsv-overlay/scripts/overlay-cli.mjs');

interface OverlayConfig {
  overlayUrl?: string;
  walletDir?: string;
  maxAutoPaySats?: number;
  dailyBudgetSats?: number;
  autoAcceptPayments?: boolean;
  preferCheapest?: boolean;
  services?: string[];
}

class OverlayService {
  private ws: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectDelay = 1000; // Start with 1 second
  private maxReconnectDelay = 30000; // Max 30 seconds
  private logger: any;
  private config: OverlayConfig;

  constructor(logger: any, config: OverlayConfig) {
    this.logger = logger;
    this.config = config;
  }

  async start() {
    this.logger.info('Starting BSV Overlay service...');
    await this.connect();
  }

  async stop() {
    this.logger.info('Stopping BSV Overlay service...');
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  private async connect() {
    try {
      // Get our identity key first
      const identity = await this.execOverlay(['identity']);
      const identityKey = identity.data.identityKey;
      
      const wsUrl = `${this.config.overlayUrl?.replace('http', 'ws')}/relay/subscribe?identity=${identityKey}`;
      this.logger.info(`Connecting to overlay relay: ${wsUrl}`);

      this.ws = new WebSocket(wsUrl);

      this.ws.on('open', () => {
        this.logger.info('Connected to BSV Overlay relay');
        this.reconnectDelay = 1000; // Reset delay on successful connection
      });

      this.ws.on('message', async (data: Buffer) => {
        try {
          const message = JSON.parse(data.toString());
          await this.processMessage(message);
        } catch (error) {
          this.logger.error('Error processing relay message:', error);
        }
      });

      this.ws.on('close', () => {
        this.logger.warn('Disconnected from BSV Overlay relay');
        this.scheduleReconnect();
      });

      this.ws.on('error', (error: Error) => {
        this.logger.error('BSV Overlay relay error:', error);
      });

    } catch (error) {
      this.logger.error('Failed to connect to BSV Overlay relay:', error);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectDelay);

    // Exponential backoff with max
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
  }

  private async processMessage(message: any) {
    // Process messages using the CLI's poll logic
    try {
      await this.execOverlay(['poll']);
    } catch (error) {
      this.logger.error('Error processing overlay messages:', error);
    }
  }

  private async execOverlay(args: string[]): Promise<any> {
    const result = await execFileAsync('node', [CLI_PATH, ...args], {
      env: {
        ...process.env,
        OVERLAY_URL: this.config.overlayUrl || 'http://162.243.168.235:8080',
        BSV_WALLET_DIR: this.config.walletDir,
      }
    });
    
    if (result.stderr) {
      this.logger.warn('Overlay CLI stderr:', result.stderr);
    }
    
    const output = JSON.parse(result.stdout);
    if (!output.success) {
      throw new Error(output.error || 'Unknown CLI error');
    }
    
    return output;
  }
}

export default function register(api: any) {
  const logger = api.logger;
  let overlayService: OverlayService | null = null;

  // Helper function to execute overlay CLI commands
  async function execOverlay(args: string[]): Promise<any> {
    const config = api.getConfig()?.plugins?.entries?.['bsv-overlay']?.config || {};
    
    const result = await execFileAsync('node', [CLI_PATH, ...args], {
      env: {
        ...process.env,
        OVERLAY_URL: config.overlayUrl || 'http://162.243.168.235:8080',
        BSV_WALLET_DIR: config.walletDir,
      }
    });
    
    if (result.stderr) {
      logger.warn('Overlay CLI stderr:', result.stderr);
    }
    
    const output = JSON.parse(result.stdout);
    if (!output.success) {
      throw new Error(output.error || 'Unknown CLI error');
    }
    
    return output;
  }

  // Register the overlay agent tool
  api.registerTool({
    name: 'overlay',
    description: 'BSV Overlay Network agent marketplace - discover agents, pay for services, check status',
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal('request'),
        Type.Literal('discover'),
        Type.Literal('balance'),
        Type.Literal('status'),
        Type.Literal('pay')
      ]),
      service: Type.Optional(Type.String()),
      input: Type.Optional(Type.Any()),
      maxPrice: Type.Optional(Type.Number()),
      agent: Type.Optional(Type.String()),
      identityKey: Type.Optional(Type.String()),
      sats: Type.Optional(Type.Number()),
      description: Type.Optional(Type.String())
    }),
    async execute(_id: string, params: any) {
      try {
        const config = api.getConfig()?.plugins?.entries?.['bsv-overlay']?.config || {};
        
        switch (params.action) {
          case 'request': {
            if (!params.service) {
              throw new Error('service parameter required for request action');
            }
            
            // 1. Discover providers for the service
            const discovery = await execOverlay(['discover', '--service', params.service]);
            const providers = discovery.data.services || [];
            
            if (providers.length === 0) {
              return { 
                content: [{ 
                  type: 'text', 
                  text: `No providers found for service: ${params.service}` 
                }] 
              };
            }

            // 2. Get our own identity to filter out self
            const identity = await execOverlay(['identity']);
            const ourKey = identity.data.identityKey;
            
            // 3. Filter out self and sort by price (cheapest first)
            const availableProviders = providers
              .filter((p: any) => p.identityKey !== ourKey)
              .sort((a: any, b: any) => (a.pricingSats || 0) - (b.pricingSats || 0));
            
            if (availableProviders.length === 0) {
              return {
                content: [{
                  type: 'text',
                  text: `No external providers found for service: ${params.service}`
                }]
              };
            }

            // 4. Find the cheapest provider within budget
            const maxPrice = params.maxPrice || config.maxAutoPaySats || 200;
            const bestProvider = availableProviders.find((p: any) => 
              (p.pricingSats || 0) <= maxPrice
            );

            if (!bestProvider) {
              return {
                content: [{
                  type: 'text',
                  text: `No providers found within budget (${maxPrice} sats) for service: ${params.service}. Cheapest available: ${availableProviders[0].pricingSats} sats`
                }]
              };
            }

            // 5. Request the service
            const inputJson = JSON.stringify(params.input || {});
            const request = await execOverlay([
              'request-service',
              bestProvider.identityKey,
              params.service,
              String(bestProvider.pricingSats || 0),
              inputJson
            ]);

            // 6. Poll for response (with timeout)
            let attempts = 0;
            const maxAttempts = 12; // 2 minutes with 10s intervals
            
            while (attempts < maxAttempts) {
              await new Promise(resolve => setTimeout(resolve, 10000)); // Wait 10 seconds
              
              const pollResult = await execOverlay(['poll']);
              
              // Check if we got a response for this service
              if (pollResult.data.processed && pollResult.data.processed.length > 0) {
                for (const processed of pollResult.data.processed) {
                  if (processed.type === 'service-response' && 
                      processed.payload?.serviceId === params.service) {
                    return {
                      content: [{
                        type: 'text',
                        text: `Service result from ${bestProvider.agentName || bestProvider.identityKey}: ${JSON.stringify(processed.payload.result)}`
                      }]
                    };
                  }
                }
              }
              
              attempts++;
            }

            return {
              content: [{
                type: 'text',
                text: `Service request sent to ${bestProvider.agentName || bestProvider.identityKey} but no response received within timeout period`
              }]
            };
          }

          case 'discover': {
            const args = ['discover'];
            if (params.service) {
              args.push('--service', params.service);
            }
            if (params.agent) {
              args.push('--agent', params.agent);
            }
            
            const result = await execOverlay(args);
            
            return {
              content: [{
                type: 'text',
                text: JSON.stringify(result.data, null, 2)
              }]
            };
          }

          case 'balance': {
            const result = await execOverlay(['balance']);
            return {
              content: [{
                type: 'text',
                text: `Wallet balance: ${result.data.totalSats} satoshis`
              }]
            };
          }

          case 'status': {
            const balance = await execOverlay(['balance']);
            const identity = await execOverlay(['identity']);
            const services = await execOverlay(['services']);
            
            return {
              content: [{
                type: 'text',
                text: `BSV Overlay Status:\nIdentity: ${identity.data.identityKey}\nBalance: ${balance.data.totalSats} sats\nServices: ${services.data.services?.length || 0} registered`
              }]
            };
          }

          case 'pay': {
            if (!params.identityKey || !params.sats) {
              throw new Error('identityKey and sats parameters required for pay action');
            }
            
            const result = await execOverlay([
              'pay',
              params.identityKey,
              String(params.sats),
              params.description || 'Direct payment'
            ]);
            
            return {
              content: [{
                type: 'text',
                text: `Payment sent: ${params.sats} sats to ${params.identityKey}`
              }]
            };
          }

          default:
            throw new Error(`Unknown action: ${params.action}`);
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
          content: [{
            type: 'text',
            text: `Error: ${errorMessage}`
          }]
        };
      }
    }
  });

  // Register background service
  api.registerService({
    id: 'bsv-overlay-relay',
    start: () => {
      const config = api.getConfig()?.plugins?.entries?.['bsv-overlay']?.config || {};
      overlayService = new OverlayService(logger, config);
      return overlayService.start();
    },
    stop: () => {
      if (overlayService) {
        return overlayService.stop();
      }
    }
  });

  // Register CLI commands
  api.registerCli(({ program }: any) => {
    const overlayCmd = program
      .command('overlay')
      .description('BSV Overlay Network commands');

    overlayCmd
      .command('status')
      .description('Show wallet balance, identity, registration, and services')
      .action(async () => {
        try {
          const balance = await execOverlay(['balance']);
          const identity = await execOverlay(['identity']);
          const services = await execOverlay(['services']);
          
          console.log('BSV Overlay Status:');
          console.log(`Identity Key: ${identity.data.identityKey}`);
          console.log(`Wallet Balance: ${balance.data.totalSats} satoshis`);
          console.log(`Services Registered: ${services.data.services?.length || 0}`);
          
          if (services.data.services && services.data.services.length > 0) {
            console.log('\nServices:');
            services.data.services.forEach((service: any) => {
              console.log(`  - ${service.serviceId}: ${service.pricingSats || 0} sats`);
            });
          }
        } catch (error) {
          console.error('Error:', error instanceof Error ? error.message : String(error));
        }
      });

    overlayCmd
      .command('setup')
      .description('Initialize BSV wallet')
      .action(async () => {
        try {
          const result = await execOverlay(['setup']);
          console.log('Wallet setup completed:');
          console.log(JSON.stringify(result.data, null, 2));
        } catch (error) {
          console.error('Error:', error instanceof Error ? error.message : String(error));
        }
      });

    overlayCmd
      .command('register')
      .description('Register on overlay and advertise default services')
      .action(async () => {
        try {
          const result = await execOverlay(['register']);
          console.log('Registration completed:');
          console.log(JSON.stringify(result.data, null, 2));
        } catch (error) {
          console.error('Error:', error instanceof Error ? error.message : String(error));
        }
      });
  }, { commands: ['overlay'] });
}