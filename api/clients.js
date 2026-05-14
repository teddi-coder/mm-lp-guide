const { readFileSync } = require('fs');
const { join } = require('path');

const CLICKUP_API_BASE = 'https://api.clickup.com/api/v2';

const EXCLUDED_STATUSES = new Set(['done', 'closed']);
const EXCLUDED_PATTERNS = [
  /^Weekly Optimisations/i,
  /^May Delivery/i,
  /^April Delivery/i,
  /^\d{4}-\d{2}-\d{2}/,
];

function shouldExclude(task) {
  if (EXCLUDED_STATUSES.has(task.status.status.toLowerCase())) return true;
  if (EXCLUDED_PATTERNS.some(p => p.test(task.name))) return true;
  return false;
}

function priorityLabel(p) {
  if (!p) return null;
  const map = { urgent: '🚨 Urgent', high: '🔴 High', normal: '🟡 Normal', low: '⚪ Low' };
  return map[p] || p;
}

async function fetchTasks(listId, token) {
  const url = `${CLICKUP_API_BASE}/list/${listId}/task?subtasks=false&include_closed=false`;
  const res = await fetch(url, { headers: { Authorization: token } });
  if (!res.ok) throw new Error(`ClickUp tasks fetch failed for list ${listId}: ${res.status}`);
  const data = await res.json();
  return data.tasks || [];
}

async function fetchBriefCustomFields(taskId, token) {
  const url = `${CLICKUP_API_BASE}/task/${taskId}`;
  const res = await fetch(url, { headers: { Authorization: token } });
  if (!res.ok) return {};
  const data = await res.json();

  const fields = {};
  for (const cf of (data.custom_fields || [])) {
    if (!cf.value) continue;
    const name = cf.name;
    const val = cf.value;
    if (name === 'Client Full Name') fields.contact = val;
    if (name === 'Primary Contact') fields.contactEmail = val;
    if (name === 'Goal') fields.goal = typeof val === 'string' ? val.trim() : '';
    if (name === 'Niche') fields.niche = typeof val === 'string' ? val.trim() : '';
    if (name === 'Notes') fields.notes = typeof val === 'string' ? val.trim() : '';
    if (name === 'Target Location') fields.targetLocation = typeof val === 'string' ? val.trim() : '';
    if (name === 'Google Ads Account') fields.googleAdsUrl = val;
    if (name === 'Google Analytics') fields.ga4Url = val;
    if (name === 'Google Search Console') fields.gscUrl = val;
    if (name === 'Google Drive Folder') fields.driveUrl = val;
    if (name === 'Live URL') fields.liveUrl = val;
    if (name === 'Secondary URL') fields.secondaryUrl = val;
    if (name === 'MM Plan') {
      const options = cf.type_config?.options || [];
      const opt = options.find(o => o.orderindex === val || o.orderindex === Number(val));
      if (opt) fields.plan = opt.name;
    }
  }
  if (data.text_content) fields.briefText = data.text_content.slice(0, 800);
  return fields;
}

module.exports = async function handler(req, res) {
  const token = process.env.CLICKUP_API_TOKEN;
  if (!token) {
    return res.status(500).json({ error: 'CLICKUP_API_TOKEN not set' });
  }

  const configPath = join(process.cwd(), 'clients.json');
  const clients = JSON.parse(readFileSync(configPath, 'utf8'));

  try {
    const results = await Promise.all(clients.map(async (client) => {
      const [tasks, briefFields] = await Promise.all([
        fetchTasks(client.clickupListId, token),
        fetchBriefCustomFields(client.clickupBriefTaskId, token),
      ]);

      const activeTasks = tasks
        .filter(t => !shouldExclude(t))
        .map(t => ({
          id: t.id,
          name: t.name,
          status: t.status.status,
          priority: priorityLabel(t.priority?.priority),
          dueDate: t.due_date ? new Date(Number(t.due_date)).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' }) : null,
          url: t.url,
          assignees: t.assignees.map(a => a.username),
        }));

      return {
        ...client,
        contact: briefFields.contact || client.contact,
        contactEmail: briefFields.contactEmail || client.contactEmail,
        goal: briefFields.goal || client.goal,
        niche: briefFields.niche || client.niche,
        targetLocation: briefFields.targetLocation || '',
        googleAdsUrl: briefFields.googleAdsUrl || client.googleAdsUrl,
        ga4Url: briefFields.ga4Url || client.ga4Url,
        gscUrl: briefFields.gscUrl || client.gscUrl,
        driveUrl: briefFields.driveUrl || client.driveUrl,
        liveUrl: briefFields.liveUrl || briefFields.secondaryUrl || client.website,
        plan: briefFields.plan || client.plan,
        briefText: briefFields.briefText || '',
        activeTasks,
        taskCount: activeTasks.length,
        urgentCount: activeTasks.filter(t => t.priority === '🚨 Urgent').length,
        highCount: activeTasks.filter(t => t.priority === '🔴 High').length,
      };
    }));

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');
    return res.status(200).json(results);

  } catch (err) {
    console.error('Client snapshots API error:', err);
    return res.status(500).json({ error: err.message });
  }
};
