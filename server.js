const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const Database = require('better-sqlite3');
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = Number(process.env.PORT || 3000);
const secureCookie = process.env.COOKIE_SECURE === 'true' ? '; Secure' : '';
const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(process.env.DATABASE_PATH || path.join(DATA_DIR, 'branchboard.sqlite'));
db.pragma('foreign_keys = ON');
db.pragma('journal_mode = WAL');
db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));

const id = () => crypto.randomUUID();
const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');
const hashPassword = (password, salt = crypto.randomBytes(16).toString('hex')) => {
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, derived };
};
const passwordMatches = (password, stored) => {
  const [salt, expected] = stored.split(':');
  if (!salt || !expected) return false;
  const actual = Buffer.from(hashPassword(password, salt).derived, 'hex');
  const expectedBuffer = Buffer.from(expected, 'hex');
  return actual.length === expectedBuffer.length && crypto.timingSafeEqual(actual, expectedBuffer);
};
const savePassword = (password) => {
  const { salt, derived } = hashPassword(password);
  return `${salt}:${derived}`;
};

function seedDemoData() {
  if (db.prepare('SELECT 1 FROM organizations LIMIT 1').get()) return;

  const seed = db.transaction(() => {
    const orgAtlas = id();
    const orgNorthstar = id();
    const tenantDesign = id();
    const tenantSupport = id();
    const tenantNorth = id();
    const users = [
      { id: id(), name: 'Alex Morgan', email: 'admin@atlas.demo', role: 'org_admin', org: orgAtlas },
      { id: id(), name: 'Sam Rivera', email: 'lead@atlas.demo', role: 'tenant_admin', org: orgAtlas, tenant: tenantDesign },
      { id: id(), name: 'Jamie Chen', email: 'jamie@atlas.demo', role: 'member', org: orgAtlas, tenant: tenantDesign },
      { id: id(), name: 'Taylor Brooks', email: 'taylor@atlas.demo', role: 'member', org: orgAtlas, tenant: tenantSupport },
      { id: id(), name: 'Jordan Lee', email: 'admin@northstar.demo', role: 'org_admin', org: orgNorthstar },
      { id: id(), name: 'Casey Patel', email: 'casey@northstar.demo', role: 'tenant_admin', org: orgNorthstar, tenant: tenantNorth }
    ];
    const insertOrg = db.prepare('INSERT INTO organizations (id, name) VALUES (?, ?)');
    insertOrg.run(orgAtlas, 'Atlas Studio');
    insertOrg.run(orgNorthstar, 'Northstar Labs');
    const insertTenant = db.prepare('INSERT INTO tenants (id, organization_id, name) VALUES (?, ?, ?)');
    insertTenant.run(tenantDesign, orgAtlas, 'Design Studio');
    insertTenant.run(tenantSupport, orgAtlas, 'Customer Success');
    insertTenant.run(tenantNorth, orgNorthstar, 'Product Team');
    const insertUser = db.prepare('INSERT INTO users (id, name, email, password_hash) VALUES (?, ?, ?, ?)');
    const insertMembership = db.prepare(
      'INSERT INTO memberships (id, user_id, organization_id, tenant_id, role) VALUES (?, ?, ?, ?, ?)'
    );
    for (const user of users) {
      insertUser.run(user.id, user.name, user.email, savePassword('demo123'));
      insertMembership.run(id(), user.id, user.org, user.tenant || null, user.role);
    }

    const insertBoard = db.prepare('INSERT INTO boards (id, tenant_id, name) VALUES (?, ?, ?)');
    const insertColumn = db.prepare(
      'INSERT INTO columns (id, tenant_id, board_id, name, position) VALUES (?, ?, ?, ?, ?)'
    );
    const insertTask = db.prepare(`
      INSERT INTO tasks (id, tenant_id, board_id, column_id, title, description, position, assignee_id, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const demos = [
      {
        tenant: tenantDesign, boardName: 'Product launch', owner: users[1],
        tasks: [
          ['Map the onboarding journey', 'Identify the moments that matter in a new customer’s first week.', 0, 0],
          ['Review mobile layouts', 'Check the latest responsive screens before handoff.', 1, 0],
          ['Write launch announcement', 'Draft a short, friendly release note.', 1, 1],
          ['Get stakeholder sign-off', 'Share the launch checklist with the team.', 2, 0]
        ]
      },
      {
        tenant: tenantSupport, boardName: 'Support operations', owner: users[3],
        tasks: [
          ['Refresh help center guides', 'Update the most visited articles for the latest release.', 0, 0],
          ['Review weekly feedback', 'Collect themes from recent customer conversations.', 1, 0]
        ]
      },
      {
        tenant: tenantNorth, boardName: 'Q4 roadmap', owner: users[5],
        tasks: [
          ['Plan roadmap review', 'Prepare the next quarterly planning session.', 0, 0],
          ['Prototype reporting view', 'Explore a clearer way to present team progress.', 1, 0]
        ]
      }
    ];
    for (const demo of demos) {
      const boardId = id();
      insertBoard.run(boardId, demo.tenant, demo.boardName);
      const columnIds = ['To do', 'In progress', 'Done'].map((name, index) => {
        const columnId = id();
        insertColumn.run(columnId, demo.tenant, boardId, name, index);
        return columnId;
      });
      for (const [title, description, columnIndex, position] of demo.tasks) {
        insertTask.run(id(), demo.tenant, boardId, columnIds[columnIndex], title, description, position * 1024,
          demo.owner.id, demo.owner.id);
      }
    }
  });
  seed();
}

seedDemoData();
db.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')").run();

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
const tenantSockets = new Map();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

function cookieValue(req, name) {
  const cookies = (req.headers.cookie || '').split(';');
  for (const cookie of cookies) {
    const separator = cookie.indexOf('=');
    if (separator < 0) continue;
    if (cookie.slice(0, separator).trim() === name) {
      return decodeURIComponent(cookie.slice(separator + 1).trim());
    }
  }
  return null;
}

function sessionUser(req) {
  const token = cookieValue(req, 'branchboard_session');
  if (!token) return null;
  return db.prepare(`
    SELECT u.id, u.name, u.email
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > datetime('now')
  `).get(hashToken(token)) || null;
}

function requireAuth(req, res, next) {
  const user = sessionUser(req);
  if (!user) return res.status(401).json({ error: 'Authentication required.' });
  req.user = user;
  next();
}

function requireTenant(req, res, tenantId, allowedRoles) {
  if (!tenantId || typeof tenantId !== 'string') {
    res.status(400).json({ error: 'A tenant_id is required.' });
    return null;
  }
  const access = db.prepare(`
    SELECT t.id AS tenant_id, t.organization_id, m.role
    FROM tenants t
    JOIN memberships m ON m.organization_id = t.organization_id
      AND m.user_id = ?
      AND (m.tenant_id = t.id OR m.tenant_id IS NULL)
    WHERE t.id = ?
    ORDER BY CASE WHEN m.role = 'org_admin' THEN 0 ELSE 1 END,
      CASE WHEN m.tenant_id = t.id THEN 0 ELSE 1 END
    LIMIT 1
  `).get(req.user.id, tenantId);
  if (!access) {
    res.status(404).json({ error: 'Tenant not found.' });
    return null;
  }
  if (allowedRoles && !allowedRoles.includes(access.role)) {
    res.status(403).json({ error: 'Your role cannot perform this action.' });
    return null;
  }
  return access;
}

function tenantIdFromRequest(req) {
  return req.params.tenantId || req.query.tenant_id || req.body?.tenant_id;
}

function writeActivity(tenantId, actorId, action, entityType, entityId, details = {}) {
  db.prepare(`
    INSERT INTO activity_logs (id, tenant_id, actor_id, action, entity_type, entity_id, details)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id(), tenantId, actorId, action, entityType, entityId, JSON.stringify(details));
}

function publish(tenantId, type, data = {}) {
  const clients = tenantSockets.get(tenantId);
  if (!clients) return;
  const payload = JSON.stringify({ type, tenant_id: tenantId, data });
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) client.send(payload);
  }
}

function addTenantSocket(tenantId, socket) {
  if (!tenantSockets.has(tenantId)) tenantSockets.set(tenantId, new Set());
  tenantSockets.get(tenantId).add(socket);
}

function removeTenantSocket(tenantId, socket) {
  const clients = tenantSockets.get(tenantId);
  if (!clients) return;
  clients.delete(socket);
  if (clients.size === 0) tenantSockets.delete(tenantId);
  publish(tenantId, 'presence.updated', { users: tenantPresence(tenantId) });
}

function tenantPresence(tenantId) {
  const uniqueUsers = new Map();
  for (const client of tenantSockets.get(tenantId) || []) {
    uniqueUsers.set(client.user.id, { id: client.user.id, name: client.user.name });
  }
  return [...uniqueUsers.values()];
}

function boardSnapshot(boardId, tenantId) {
  const board = db.prepare('SELECT id, tenant_id, name, created_at FROM boards WHERE id = ? AND tenant_id = ?')
    .get(boardId, tenantId);
  if (!board) return null;
  board.columns = db.prepare(
    'SELECT id, name, position FROM columns WHERE board_id = ? AND tenant_id = ? ORDER BY position, id'
  ).all(boardId, tenantId);
  const tasks = db.prepare(`
    SELECT t.id, t.tenant_id, t.board_id, t.column_id, t.title, t.description, t.position,
      t.version, t.assignee_id, t.due_date, t.created_by, t.created_at, t.updated_at,
      u.name AS assignee_name
    FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id
    WHERE t.board_id = ? AND t.tenant_id = ?
    ORDER BY t.column_id, t.position, t.id
  `).all(boardId, tenantId);
  const byColumn = new Map(board.columns.map((column) => [column.id, []]));
  for (const task of tasks) byColumn.get(task.column_id)?.push(task);
  board.columns = board.columns.map((column) => ({ ...column, tasks: byColumn.get(column.id) || [] }));
  return board;
}

function emitBoard(tenantId, boardId) {
  const board = boardSnapshot(boardId, tenantId);
  if (board) publish(tenantId, 'board.updated', { board });
}

const roles = { admin: 'org_admin', tenantAdmin: 'tenant_admin', member: 'member' };
const tenantAdmins = [roles.admin, roles.tenantAdmin];
const route = (handler) => (req, res, next) => {
  try {
    handler(req, res, next);
  } catch (error) {
    next(error);
  }
};

app.post('/api/auth/login', route((req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = req.body?.password;
  if (typeof password !== 'string' || password.length === 0 || password.length > 200) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }
  const user = db.prepare('SELECT id, name, email, password_hash FROM users WHERE email = ? COLLATE NOCASE').get(email);
  if (!user || !passwordMatches(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid email or password.' });
  }
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, datetime(\'now\', \'+7 days\'))')
    .run(hashToken(token), user.id);
  res.setHeader('Set-Cookie', `branchboard_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${secureCookie}`);
  res.json({ user: { id: user.id, name: user.name, email: user.email } });
}));

app.post('/api/auth/logout', route((req, res) => {
  const token = cookieValue(req, 'branchboard_session');
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
  res.setHeader('Set-Cookie', `branchboard_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secureCookie}`);
  res.json({ ok: true });
}));

app.use('/api', requireAuth);

app.get('/api/me', route((req, res) => {
  const organizations = db.prepare(`
    SELECT DISTINCT o.id, o.name
    FROM organizations o JOIN memberships m ON m.organization_id = o.id
    WHERE m.user_id = ? ORDER BY o.name
  `).all(req.user.id);
  const memberships = db.prepare(`
    SELECT t.id AS tenant_id, t.name AS tenant_name, m.organization_id, m.role
    FROM memberships m LEFT JOIN tenants t ON t.id = m.tenant_id
    WHERE m.user_id = ?
  `).all(req.user.id);
  res.json({ user: req.user, organizations, memberships });
}));

app.get('/api/organizations', route((req, res) => {
  res.json(db.prepare(`
    SELECT DISTINCT o.id, o.name, o.created_at
    FROM organizations o JOIN memberships m ON m.organization_id = o.id
    WHERE m.user_id = ? ORDER BY o.name
  `).all(req.user.id));
}));

app.post('/api/organizations', route((req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name || name.length > 100) return res.status(400).json({ error: 'Name must be 1–100 characters.' });
  const create = db.transaction(() => {
    const organizationId = id();
    db.prepare('INSERT INTO organizations (id, name) VALUES (?, ?)').run(organizationId, name);
    db.prepare(`
      INSERT INTO memberships (id, user_id, organization_id, tenant_id, role)
      VALUES (?, ?, ?, NULL, 'org_admin')
    `).run(id(), req.user.id, organizationId);
    return db.prepare('SELECT id, name, created_at FROM organizations WHERE id = ?').get(organizationId);
  });
  res.status(201).json(create());
}));

app.patch('/api/organizations/:id', route((req, res) => {
  const organizationId = req.params.id;
  const membership = db.prepare(`
    SELECT 1 FROM memberships WHERE user_id = ? AND organization_id = ? AND role = 'org_admin'
  `).get(req.user.id, organizationId);
  if (!membership) return res.status(404).json({ error: 'Organization not found.' });
  const name = String(req.body?.name || '').trim();
  if (!name || name.length > 100) return res.status(400).json({ error: 'Name must be 1–100 characters.' });
  db.prepare('UPDATE organizations SET name = ? WHERE id = ?').run(name, organizationId);
  res.json(db.prepare('SELECT id, name, created_at FROM organizations WHERE id = ?').get(organizationId));
}));

app.delete('/api/organizations/:id', route((req, res) => {
  const organizationId = req.params.id;
  const membership = db.prepare(`
    SELECT 1 FROM memberships WHERE user_id = ? AND organization_id = ? AND role = 'org_admin'
  `).get(req.user.id, organizationId);
  if (!membership) return res.status(404).json({ error: 'Organization not found.' });
  db.prepare('DELETE FROM organizations WHERE id = ?').run(organizationId);
  res.status(204).end();
}));

app.get('/api/organizations/:organizationId/tenants', route((req, res) => {
  const tenants = db.prepare(`
    SELECT DISTINCT t.id, t.organization_id, t.name, t.created_at
    FROM tenants t JOIN memberships m ON m.organization_id = t.organization_id
      AND m.user_id = ? AND (m.tenant_id = t.id OR m.tenant_id IS NULL)
    WHERE t.organization_id = ? ORDER BY t.name
  `).all(req.user.id, req.params.organizationId);
  if (!tenants.length) {
    const hasTenantlessOrg = db.prepare(
      'SELECT 1 FROM memberships WHERE user_id = ? AND organization_id = ? AND tenant_id IS NULL'
    ).get(req.user.id, req.params.organizationId);
    if (!hasTenantlessOrg) return res.status(404).json({ error: 'Organization not found.' });
  }
  res.json(tenants);
}));

app.post('/api/tenants', route((req, res) => {
  const { organization_id: organizationId } = req.body || {};
  const name = String(req.body?.name || '').trim();
  const isOrgAdmin = db.prepare(`
    SELECT 1 FROM memberships WHERE user_id = ? AND organization_id = ? AND tenant_id IS NULL
      AND role = 'org_admin'
  `).get(req.user.id, organizationId);
  if (!isOrgAdmin) return res.status(404).json({ error: 'Organization not found.' });
  if (!name || name.length > 100) return res.status(400).json({ error: 'Name must be 1–100 characters.' });
  const tenant = { id: id(), organization_id: organizationId, name };
  const create = db.transaction(() => {
    db.prepare('INSERT INTO tenants (id, organization_id, name) VALUES (?, ?, ?)').run(
      tenant.id, tenant.organization_id, tenant.name
    );
    const boardId = id();
    db.prepare('INSERT INTO boards (id, tenant_id, name) VALUES (?, ?, ?)').run(boardId, tenant.id, 'Team board');
    const insertColumn = db.prepare(
      'INSERT INTO columns (id, tenant_id, board_id, name, position) VALUES (?, ?, ?, ?, ?)'
    );
    ['To do', 'In progress', 'Done'].forEach((column, position) => {
      insertColumn.run(id(), tenant.id, boardId, column, position);
    });
    return { ...tenant, created_at: new Date().toISOString() };
  });
  res.status(201).json(create());
}));

app.patch('/api/tenants/:tenantId', route((req, res) => {
  const access = requireTenant(req, res, req.params.tenantId, [roles.admin]);
  if (!access) return;
  const name = String(req.body?.name || '').trim();
  if (!name || name.length > 100) return res.status(400).json({ error: 'Name must be 1–100 characters.' });
  db.prepare('UPDATE tenants SET name = ? WHERE id = ?').run(name, access.tenant_id);
  res.json(db.prepare('SELECT id, organization_id, name, created_at FROM tenants WHERE id = ?')
    .get(access.tenant_id));
}));

app.delete('/api/tenants/:tenantId', route((req, res) => {
  const access = requireTenant(req, res, req.params.tenantId, [roles.admin]);
  if (!access) return;
  db.prepare('DELETE FROM tenants WHERE id = ?').run(access.tenant_id);
  res.status(204).end();
}));

app.get('/api/boards', route((req, res) => {
  const access = requireTenant(req, res, req.query.tenant_id);
  if (!access) return;
  res.json(db.prepare('SELECT id, tenant_id, name, created_at FROM boards WHERE tenant_id = ? ORDER BY created_at')
    .all(access.tenant_id));
}));

app.get('/api/boards/:boardId', route((req, res) => {
  const access = requireTenant(req, res, req.query.tenant_id);
  if (!access) return;
  const board = boardSnapshot(req.params.boardId, access.tenant_id);
  if (!board) return res.status(404).json({ error: 'Board not found.' });
  res.json(board);
}));

app.post('/api/boards', route((req, res) => {
  const access = requireTenant(req, res, req.body?.tenant_id, tenantAdmins);
  if (!access) return;
  const name = String(req.body?.name || '').trim();
  if (!name || name.length > 100) return res.status(400).json({ error: 'Name must be 1–100 characters.' });
  const boardId = id();
  const create = db.transaction(() => {
    db.prepare('INSERT INTO boards (id, tenant_id, name) VALUES (?, ?, ?)').run(boardId, access.tenant_id, name);
    const insert = db.prepare(
      'INSERT INTO columns (id, tenant_id, board_id, name, position) VALUES (?, ?, ?, ?, ?)'
    );
    ['To do', 'In progress', 'Done'].forEach((column, position) => {
      insert.run(id(), access.tenant_id, boardId, column, position);
    });
    writeActivity(access.tenant_id, req.user.id, 'created', 'board', boardId, { name });
  });
  create();
  publish(access.tenant_id, 'boards.updated', { board_id: boardId });
  res.status(201).json(boardSnapshot(boardId, access.tenant_id));
}));

app.patch('/api/boards/:boardId', route((req, res) => {
  const access = requireTenant(req, res, tenantIdFromRequest(req), tenantAdmins);
  if (!access) return;
  const board = db.prepare('SELECT id FROM boards WHERE id = ? AND tenant_id = ?')
    .get(req.params.boardId, access.tenant_id);
  if (!board) return res.status(404).json({ error: 'Board not found.' });
  const name = String(req.body?.name || '').trim();
  if (!name || name.length > 100) return res.status(400).json({ error: 'Name must be 1–100 characters.' });
  db.prepare('UPDATE boards SET name = ? WHERE id = ? AND tenant_id = ?')
    .run(name, board.id, access.tenant_id);
  writeActivity(access.tenant_id, req.user.id, 'updated', 'board', board.id, { name });
  emitBoard(access.tenant_id, board.id);
  res.json(boardSnapshot(board.id, access.tenant_id));
}));

app.delete('/api/boards/:boardId', route((req, res) => {
  const access = requireTenant(req, res, tenantIdFromRequest(req), tenantAdmins);
  if (!access) return;
  const board = db.prepare('SELECT id FROM boards WHERE id = ? AND tenant_id = ?')
    .get(req.params.boardId, access.tenant_id);
  if (!board) return res.status(404).json({ error: 'Board not found.' });
  db.prepare('DELETE FROM boards WHERE id = ? AND tenant_id = ?').run(board.id, access.tenant_id);
  writeActivity(access.tenant_id, req.user.id, 'deleted', 'board', board.id, {});
  publish(access.tenant_id, 'board.deleted', { board_id: board.id });
  publish(access.tenant_id, 'activity.updated');
  res.status(204).end();
}));

app.get('/api/columns', route((req, res) => {
  const access = requireTenant(req, res, req.query.tenant_id);
  if (!access) return;
  const boardId = req.query.board_id;
  if (!db.prepare('SELECT 1 FROM boards WHERE id = ? AND tenant_id = ?').get(boardId, access.tenant_id)) {
    return res.status(404).json({ error: 'Board not found.' });
  }
  res.json(db.prepare('SELECT id, tenant_id, board_id, name, position FROM columns WHERE board_id = ? AND tenant_id = ? ORDER BY position')
    .all(boardId, access.tenant_id));
}));

app.post('/api/columns', route((req, res) => {
  const access = requireTenant(req, res, req.body?.tenant_id, tenantAdmins);
  if (!access) return;
  const boardId = req.body?.board_id;
  const name = String(req.body?.name || '').trim();
  if (!name || name.length > 60) return res.status(400).json({ error: 'Name must be 1–60 characters.' });
  const board = db.prepare('SELECT id FROM boards WHERE id = ? AND tenant_id = ?').get(boardId, access.tenant_id);
  if (!board) return res.status(404).json({ error: 'Board not found.' });
  const position = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS position FROM columns WHERE board_id = ? AND tenant_id = ?')
    .get(boardId, access.tenant_id).position;
  const column = { id: id(), tenant_id: access.tenant_id, board_id: boardId, name, position };
  db.prepare('INSERT INTO columns (id, tenant_id, board_id, name, position) VALUES (?, ?, ?, ?, ?)')
    .run(column.id, column.tenant_id, column.board_id, column.name, column.position);
  writeActivity(access.tenant_id, req.user.id, 'created', 'column', column.id, { name });
  emitBoard(access.tenant_id, boardId);
  res.status(201).json(column);
}));

app.patch('/api/columns/:columnId', route((req, res) => {
  const access = requireTenant(req, res, tenantIdFromRequest(req), tenantAdmins);
  if (!access) return;
  const column = db.prepare('SELECT id, board_id FROM columns WHERE id = ? AND tenant_id = ?')
    .get(req.params.columnId, access.tenant_id);
  if (!column) return res.status(404).json({ error: 'Column not found.' });
  const name = String(req.body?.name || '').trim();
  if (!name || name.length > 60) return res.status(400).json({ error: 'Name must be 1–60 characters.' });
  db.prepare('UPDATE columns SET name = ? WHERE id = ? AND tenant_id = ?').run(name, column.id, access.tenant_id);
  writeActivity(access.tenant_id, req.user.id, 'updated', 'column', column.id, { name });
  emitBoard(access.tenant_id, column.board_id);
  res.json(db.prepare('SELECT id, tenant_id, board_id, name, position FROM columns WHERE id = ?')
    .get(column.id));
}));

app.delete('/api/columns/:columnId', route((req, res) => {
  const access = requireTenant(req, res, tenantIdFromRequest(req), tenantAdmins);
  if (!access) return;
  const column = db.prepare('SELECT id, board_id FROM columns WHERE id = ? AND tenant_id = ?')
    .get(req.params.columnId, access.tenant_id);
  if (!column) return res.status(404).json({ error: 'Column not found.' });
  const columnCount = db.prepare('SELECT COUNT(*) AS count FROM columns WHERE board_id = ? AND tenant_id = ?')
    .get(column.board_id, access.tenant_id).count;
  const taskCount = db.prepare('SELECT COUNT(*) AS count FROM tasks WHERE column_id = ? AND tenant_id = ?')
    .get(column.id, access.tenant_id).count;
  if (columnCount <= 1) return res.status(409).json({ error: 'A board must keep at least one column.' });
  if (taskCount > 0) return res.status(409).json({ error: 'Move or delete this column’s tasks before deleting it.' });
  db.prepare('DELETE FROM columns WHERE id = ? AND tenant_id = ?').run(column.id, access.tenant_id);
  writeActivity(access.tenant_id, req.user.id, 'deleted', 'column', column.id, {});
  emitBoard(access.tenant_id, column.board_id);
  res.status(204).end();
}));

app.post('/api/tasks', route((req, res) => {
  const access = requireTenant(req, res, req.body?.tenant_id);
  if (!access) return;
  const boardId = req.body?.board_id;
  const columnId = req.body?.column_id;
  const title = String(req.body?.title || '').trim();
  const description = String(req.body?.description || '');
  if (!title || title.length > 200) return res.status(400).json({ error: 'Title must be 1–200 characters.' });
  if (description.length > 10000) return res.status(400).json({ error: 'Description cannot exceed 10,000 characters.' });
  const column = db.prepare('SELECT id FROM columns WHERE id = ? AND board_id = ? AND tenant_id = ?')
    .get(columnId, boardId, access.tenant_id);
  if (!column) return res.status(404).json({ error: 'Column not found.' });
  const existingTasks = db.prepare('SELECT id FROM tasks WHERE column_id = ? AND tenant_id = ? ORDER BY position, id')
    .all(columnId, access.tenant_id);
  if (req.body.position !== undefined &&
      (!Number.isInteger(req.body.position) || req.body.position < 0 || req.body.position > 1000000000)) {
    return res.status(400).json({ error: 'Position must be a non-negative integer.' });
  }
  const positionIndex = Math.min(req.body.position ?? existingTasks.length, existingTasks.length);
  const position = positionIndex * 1024;
  const taskId = id();
  const assignee = req.body?.assignee_id || null;
  if (assignee && !db.prepare(`
    SELECT 1 FROM memberships WHERE user_id = ? AND organization_id = ? AND
      (tenant_id = ? OR (tenant_id IS NULL AND role = 'org_admin'))
  `).get(assignee, access.organization_id, access.tenant_id)) {
    return res.status(400).json({ error: 'Assignee must belong to this tenant.' });
  }
  const create = db.transaction(() => {
    db.prepare(`
      INSERT INTO tasks (id, tenant_id, board_id, column_id, title, description, position, assignee_id, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(taskId, access.tenant_id, boardId, columnId, title, description, position, assignee, req.user.id);
    if (positionIndex < existingTasks.length) {
      existingTasks.slice(positionIndex).forEach((item, index) => db.prepare(`
        UPDATE tasks SET position = ?, version = version + 1, updated_at = datetime('now')
        WHERE id = ? AND tenant_id = ?
      `).run((positionIndex + index + 1) * 1024, item.id, access.tenant_id));
    }
    writeActivity(access.tenant_id, req.user.id, 'created', 'task', taskId, { title });
  });
  create();
  emitBoard(access.tenant_id, boardId);
  res.status(201).json(db.prepare(`
    SELECT id, tenant_id, board_id, column_id, title, description, position, version, assignee_id,
      due_date, created_by, created_at, updated_at
    FROM tasks WHERE id = ? AND tenant_id = ?
  `).get(taskId, access.tenant_id));
}));

app.patch('/api/tasks/:taskId', route((req, res) => {
  const access = requireTenant(req, res, tenantIdFromRequest(req));
  if (!access) return;
  const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND tenant_id = ?')
    .get(req.params.taskId, access.tenant_id);
  if (!task) return res.status(404).json({ error: 'Task not found.' });
  const expectedVersion = Number(req.body?.expected_version);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
    return res.status(400).json({ error: 'A valid expected_version is required.' });
  }
  if (task.version !== expectedVersion) {
    return res.status(409).json({ error: 'This task changed since you opened it.', current: task });
  }
  const allowedFields = ['title', 'description', 'assignee_id', 'due_date'];
  const updates = {};
  for (const key of allowedFields) if (Object.hasOwn(req.body, key)) updates[key] = req.body[key];
  if (Object.hasOwn(req.body, 'column_id')) updates.column_id = req.body.column_id;
  if (Object.hasOwn(req.body, 'position')) updates.position = req.body.position;
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'No task fields to update.' });
  if (updates.title !== undefined) {
    if (typeof updates.title !== 'string' || !updates.title.trim() || updates.title.length > 200) {
      return res.status(400).json({ error: 'Title must be 1–200 characters.' });
    }
    updates.title = updates.title.trim();
  }
  if (updates.description !== undefined &&
      (typeof updates.description !== 'string' || updates.description.length > 10000)) {
    return res.status(400).json({ error: 'Description cannot exceed 10,000 characters.' });
  }
  if (updates.assignee_id) {
    const assignee = db.prepare(`
      SELECT 1 FROM memberships WHERE user_id = ? AND organization_id = ? AND
        (tenant_id = ? OR (tenant_id IS NULL AND role = 'org_admin'))
    `).get(updates.assignee_id, access.organization_id, access.tenant_id);
    if (!assignee) return res.status(400).json({ error: 'Assignee must belong to this tenant.' });
  } else if (updates.assignee_id === '') {
    updates.assignee_id = null;
  }
  if (updates.due_date !== undefined && updates.due_date !== null && updates.due_date !== '' &&
      (typeof updates.due_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(updates.due_date))) {
    return res.status(400).json({ error: 'Due date must use YYYY-MM-DD format.' });
  }
  if (updates.due_date === '') updates.due_date = null;

  const nextColumn = updates.column_id || task.column_id;
  if (updates.column_id && !db.prepare('SELECT 1 FROM columns WHERE id = ? AND board_id = ? AND tenant_id = ?')
    .get(nextColumn, task.board_id, access.tenant_id)) {
    return res.status(404).json({ error: 'Column not found.' });
  }
  if (updates.position !== undefined &&
      (!Number.isInteger(updates.position) || updates.position < 0 || updates.position > 1000000000)) {
    return res.status(400).json({ error: 'Position must be a non-negative integer.' });
  }

  const updateTask = db.transaction(() => {
    const fields = Object.keys(updates).filter((key) => key !== 'column_id' && key !== 'position');
    const isReordering = updates.column_id !== undefined || updates.position !== undefined;
    if (isReordering) {
      const assignments = fields.map((field) => `${field} = @${field}`);
      assignments.push("version = version + 1", "updated_at = datetime('now')");
      const claimed = db.prepare(`
        UPDATE tasks SET ${assignments.join(', ')}
        WHERE id = @id AND tenant_id = @tenant_id AND version = @expected_version
      `).run({ ...updates, id: task.id, tenant_id: access.tenant_id, expected_version: expectedVersion });
      if (claimed.changes === 0) return false;
    }
    if (updates.column_id !== undefined || updates.position !== undefined) {
      const targetTasks = db.prepare(`
        SELECT id FROM tasks WHERE column_id = ? AND tenant_id = ? AND id != ?
        ORDER BY position, id
      `).all(nextColumn, access.tenant_id, task.id);
      const insertAt = Math.max(0, Math.min(
        updates.position === undefined ? targetTasks.length : updates.position,
        targetTasks.length
      ));
      targetTasks.splice(insertAt, 0, { id: task.id });
      const normalize = db.prepare(`
        UPDATE tasks SET column_id = ?, position = ?, version = version + 1, updated_at = datetime('now')
        WHERE id = ? AND tenant_id = ?
      `);
      targetTasks.forEach((item, index) => normalize.run(nextColumn, index * 1024, item.id, access.tenant_id));
      if (nextColumn !== task.column_id) {
        const sourceTasks = db.prepare(`
          SELECT id FROM tasks WHERE column_id = ? AND tenant_id = ? ORDER BY position, id
        `).all(task.column_id, access.tenant_id);
        sourceTasks.forEach((item, index) => db.prepare(`
          UPDATE tasks SET position = ?, version = version + 1, updated_at = datetime('now')
          WHERE id = ? AND tenant_id = ?
        `).run(index * 1024, item.id, access.tenant_id));
      }
    }
    if (fields.length > 0 && !isReordering) {
      const assignments = fields.map((field) => `${field} = @${field}`).join(', ');
      const result = db.prepare(`
        UPDATE tasks SET ${assignments}, version = version + 1, updated_at = datetime('now')
        WHERE id = @id AND tenant_id = @tenant_id AND version = @expected_version
      `).run({ ...updates, id: task.id, tenant_id: access.tenant_id, expected_version: expectedVersion });
      if (result.changes === 0) return false;
    } else if (!isReordering) {
      const result = db.prepare(`
        UPDATE tasks SET version = version + 1, updated_at = datetime('now')
        WHERE id = ? AND tenant_id = ? AND version = ?
      `).run(task.id, access.tenant_id, expectedVersion);
      if (result.changes === 0) return false;
    }
    writeActivity(access.tenant_id, req.user.id, 'updated', 'task', task.id, {
      fields: Object.keys(updates), previous: task
    });
    return true;
  });
  if (!updateTask()) {
    return res.status(409).json({
      error: 'This task changed since you opened it.',
      current: db.prepare('SELECT * FROM tasks WHERE id = ? AND tenant_id = ?').get(task.id, access.tenant_id)
    });
  }
  emitBoard(access.tenant_id, task.board_id);
  publish(access.tenant_id, 'activity.updated');
  res.json(db.prepare(`
    SELECT t.id, t.tenant_id, t.board_id, t.column_id, t.title, t.description, t.position, t.version,
      t.assignee_id, t.due_date, t.created_by, t.created_at, t.updated_at, u.name AS assignee_name
    FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id
    WHERE t.id = ? AND t.tenant_id = ?
  `).get(task.id, access.tenant_id));
  
}));

app.delete('/api/tasks/:taskId', route((req, res) => {
  const access = requireTenant(req, res, tenantIdFromRequest(req));
  if (!access) return;
  const task = db.prepare('SELECT id, board_id, title, version FROM tasks WHERE id = ? AND tenant_id = ?')
    .get(req.params.taskId, access.tenant_id);
  if (!task) return res.status(404).json({ error: 'Task not found.' });
  const expectedVersion = Number(req.query.expected_version);
  if (task.version !== expectedVersion) return res.status(409).json({ error: 'This task changed since you opened it.' });
  const remove = db.transaction(() => {
    const result = db.prepare('DELETE FROM tasks WHERE id = ? AND tenant_id = ? AND version = ?')
      .run(task.id, access.tenant_id, expectedVersion);
    if (result.changes === 0) return false;
    writeActivity(access.tenant_id, req.user.id, 'deleted', 'task', task.id, { title: task.title });
    return true;
  });
  if (!remove()) return res.status(409).json({ error: 'This task changed since you opened it.' });
  emitBoard(access.tenant_id, task.board_id);
  publish(access.tenant_id, 'activity.updated');
  res.status(204).end();
}));

app.get('/api/activity', route((req, res) => {
  const access = requireTenant(req, res, req.query.tenant_id);
  if (!access) return;
  const limit = Math.max(1, Math.min(Number(req.query.limit) || 30, 100));
  res.json(db.prepare(`
    SELECT a.id, a.action, a.entity_type, a.entity_id, a.details, a.created_at, u.name AS actor_name
    FROM activity_logs a LEFT JOIN users u ON u.id = a.actor_id
    WHERE a.tenant_id = ? ORDER BY a.created_at DESC, a.rowid DESC LIMIT ?
  `).all(access.tenant_id, limit).map((entry) => ({ ...entry, details: JSON.parse(entry.details) })));
}));

app.get('/api/tenant-members', route((req, res) => {
  const access = requireTenant(req, res, req.query.tenant_id);
  if (!access) return;
  res.json(db.prepare(`
    SELECT DISTINCT u.id, u.name, u.email, m.role
    FROM memberships m JOIN users u ON u.id = m.user_id
    WHERE m.organization_id = ? AND (m.tenant_id = ? OR (m.tenant_id IS NULL AND m.role = 'org_admin'))
    ORDER BY u.name
  `).all(access.organization_id, access.tenant_id));
}));

app.use('/api', (req, res) => res.status(404).json({ error: 'API route not found.' }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  console.error(error);
  res.status(500).json({ error: 'An unexpected server error occurred.' });
});

function websocketUser(req) {
  const user = sessionUser(req);
  return user;
}

server.on('upgrade', (req, socket, head) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (requestUrl.pathname !== '/realtime') {
    socket.destroy();
    return;
  }
  if (req.headers.origin) {
    let originHost;
    try {
      originHost = new URL(req.headers.origin).host;
    } catch {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    if (originHost !== req.headers.host) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
  }
  const user = websocketUser(req);
  if (!user) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (client) => {
    client.user = user;
    wss.emit('connection', client, req);
  });
});

wss.on('connection', (socket) => {
  socket.tenantId = null;
  socket.on('message', (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      socket.send(JSON.stringify({ type: 'error', data: { message: 'Invalid WebSocket message.' } }));
      return;
    }
    if (message.type !== 'subscribe' || typeof message.tenant_id !== 'string') {
      socket.send(JSON.stringify({ type: 'error', data: { message: 'A tenant subscription is required.' } }));
      return;
    }
    const access = db.prepare(`
      SELECT t.id AS tenant_id FROM tenants t
      JOIN memberships m ON m.organization_id = t.organization_id AND m.user_id = ?
        AND (m.tenant_id = t.id OR m.tenant_id IS NULL)
      WHERE t.id = ? LIMIT 1
    `).get(socket.user.id, message.tenant_id);
    if (!access) {
      socket.send(JSON.stringify({ type: 'error', data: { message: 'Tenant not found.' } }));
      socket.close(1008, 'Tenant access denied');
      return;
    }
    if (socket.tenantId) removeTenantSocket(socket.tenantId, socket);
    socket.tenantId = access.tenant_id;
    addTenantSocket(socket.tenantId, socket);
    socket.send(JSON.stringify({ type: 'subscribed', tenant_id: socket.tenantId }));
    publish(socket.tenantId, 'presence.updated', { users: tenantPresence(socket.tenantId) });
  });
  socket.on('close', () => {
    if (socket.tenantId) removeTenantSocket(socket.tenantId, socket);
  });
  socket.on('error', (error) => console.error('WebSocket error:', error.message));
});

if (require.main === module) {
  server.listen(PORT, () => console.log(`Branchboard is running at http://localhost:${PORT}`));
}

module.exports = { app, server, db, seedDemoData, requireTenant, boardSnapshot };
