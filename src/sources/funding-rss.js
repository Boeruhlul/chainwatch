import { getText } from '../http.js';
import { slug } from '../util.js';

/**
 * Funding-nieuws: "X raises $20M to build a new Layer 1".
 *
 * Weken tot maanden vóór er ook maar een testnet is. Het is een naam, geen
 * chain, dus dit levert 'lead'-records: geen directe alert, wel een dossier.
 * Raakt later een technische bron hetzelfde project (naam, domein), dan legt
 * de dossierlaag het verband en volgt er wél een melding.
 *
 * Eén keer per uur; elke feed faalt los, de bron faalt pas als alles faalt.
 */

export const FEEDS = (process.env.FUNDING_FEEDS ||
  'https://www.theblock.co/rss.xml,https://blockworks.co/feed,https://www.coindesk.com/arc/outboundfeeds/rss/,https://decrypt.co/feed,https://cointelegraph.com/rss')
  .split(',').map((s) => s.trim()).filter(Boolean);

const MONEY = /\b(raises?|raised|raising|secures?|closes?|lands|bags|nabs|funding round|seed round|series [a-d]|strategic round)\b/i;
const CHAINY = /\b(layer[- ]?[123]|l[123]s?|rollups?|blockchains?|chain|appchains?|mainnet|testnet|network|protocol|zk|evm|svm|move)\b/i;
const NAME_RE = /^(?:[A-Z][\w-]*\s+(?:startup|project|firm|developer|team)\s+)?['"‘“]?([A-Z0-9][\w.&' -]{1,40}?)['"’”]?\s+(?:raises?|raised|secures?|closes?|lands|bags|nabs)\b/;

function decode(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&#x27;|&apos;/g, "'")
    .replace(/&#8217;|&rsquo;/g, '’').replace(/&#8216;|&lsquo;/g, '‘')
    .replace(/\s+/g, ' ')
    .trim();
}

/** RSS of Atom → [{ title, link, date, summary }]. Regex, geen XML-parser: zero deps. */
export function parseFeed(xml) {
  const items = [];
  const blocks = String(xml || '').match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) || [];
  for (const b of blocks) {
    const tag = (name) => b.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i'))?.[1];
    let link = decode(tag('link'));
    if (!link) link = b.match(/<link\b[^>]*href=["']([^"']+)["']/i)?.[1] || '';
    const title = decode(tag('title'));
    if (!title || !link) continue;
    items.push({
      title,
      link: link.trim(),
      date: decode(tag('pubDate') || tag('published') || tag('updated') || ''),
      summary: decode(tag('description') || tag('summary') || '').slice(0, 400),
    });
  }
  return items;
}

/** Is dit een financieringsbericht over iets wat een chain zou kunnen zijn? En hoe heet het? */
export function fundingLead(item) {
  const text = `${item.title} ${item.summary}`;
  if (!MONEY.test(item.title) || !CHAINY.test(text)) return null;
  const m = item.title.match(NAME_RE);
  if (!m) return null;
  const name = m[1].trim().replace(/[,:]$/, '');
  if (name.split(' ').length > 5 || /^(the|a|an|crypto|bitcoin|ethereum|this|how|why)$/i.test(name)) return null;
  return name;
}

export function inSlot(now = new Date()) {
  return now.getUTCMinutes() >= 20 && now.getUTCMinutes() < 30;
}

export default {
  id: 'funding-rss',
  label: 'Funding-nieuws (RSS)',
  url: 'https://www.theblock.co',
  shouldRun: () => process.env.FUNDING_RSS !== 'false' && (process.env.FUNDING_RSS_ALWAYS === 'true' || inSlot()),

  async fetchAll() {
    const out = new Map();
    let ok = 0;
    let lastErr;
    await Promise.all(FEEDS.map(async (feed) => {
      try {
        const { text } = await getText(feed, { timeout: 15000, maxBytes: 1500000, headers: { accept: 'application/rss+xml, application/atom+xml, text/xml;q=0.9, */*;q=0.5' } });
        ok++;
        for (const item of parseFeed(text)) {
          const name = fundingLead(item);
          if (!name) continue;
          const key = `news:${slug(item.link).slice(-120)}`;
          out.set(key, {
            key,
            source: 'funding-rss',
            name,
            nameKey: `${slug(name)}:lead`,
            kind: 'lead',
            leadKind: 'funding',
            ecosystem: 'onbekend',
            chainId: null,
            rpc: [], explorers: [], faucets: [],
            description: item.title,
            url: item.link,
            publishedAt: item.date || null,
          });
        }
      } catch (e) {
        lastErr = e;
      }
    }));
    if (!ok) throw lastErr || new Error('geen enkele feed bereikbaar');
    return [...out.values()];
  },
};
