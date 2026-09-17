#!/usr/bin/env node
/**
 * Stuurt één testbericht via exact dezelfde weg als een echte alert:
 * dezelfde formatChain(), dezelfde notify(), dezelfde secrets.
 * Komt dit bericht aan, dan werkt de hele keten.
 *
 * Draaien: node src/selftest.js  (of via de workflow met test: true)
 */
import { notify, formatChain } from './notify.js';
import { nowIso } from './util.js';

const cfg = {
  token: process.env.TELEGRAM_BOT_TOKEN,
  chatId: process.env.TELEGRAM_CHAT_ID,
};

if (!cfg.token || !cfg.chatId) {
  console.error('FOUT: TELEGRAM_BOT_TOKEN en/of TELEGRAM_CHAT_ID ontbreken.');
  console.error('Controleer Settings -> Secrets and variables -> Actions -> Secrets.');
  process.exit(1);
}

const voorbeeld = {
  key: 'selftest',
  source: 'zelftest',
  name: 'Testchain',
  kind: 'mainnet',
  ecosystem: 'EVM',
  chainId: 999999,
  nativeCurrency: 'TEST',
  rpc: ['https://rpc.testchain.example'],
  explorers: ['https://explorer.testchain.example'],
  faucets: ['https://faucet.testchain.example'],
  url: 'https://github.com/Boeruhlul/chainwatch',
  detectedAt: nowIso(),
};

const tekst =
  formatChain(voorbeeld) +
  '\n\n<i>Dit is een testbericht. Zo ziet een echte alert eruit.</i>';

const { sent, errors } = await notify([{ text: tekst, keys: ['selftest'] }], cfg);

if (errors.length) {
  console.error(`FOUT: bericht niet afgeleverd — ${errors.join('; ')}`);
  process.exit(1);
}
console.log(`Testbericht verstuurd (${sent} bericht).`);
