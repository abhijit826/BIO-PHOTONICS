import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { Prisma, ProjectStatus, Priority, TaskStatus } from '@prisma/client';
import { prisma } from './db';
import { authenticate, errors, parse } from './middleware';

const app = express();
app.use(helmet());
app.use(cors({ origin: (process.env.WEB_ORIGIN || 'http://localhost:5173').split(',').map(x => x.trim()), credentials: false }));
app.use(express.json({ limit: '1mb' }));
const authLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Too many authentication attempts. Try again in 15 minutes.' } });
const emailSchema = z.string().trim().email().max(254).transform(s => s.toLowerCase());
const text = (max: number) => z.string().trim().max(max);
const date = z.union([z.string().datetime({ offset: true }), z.string().date(), z.literal('')]).optional().nullable().transform(v => v ? new Date(v) : null);
const projectStatus = z.nativeEnum(ProjectStatus);
const taskStatus = z.nativeEnum(TaskStatus);
const priority = z.nativeEnum(Priority);
const registerSchema = z.object({ fullName: text(100).min(1), email: emailSchema, password: z.string().min(8).max(72) });
const loginSchema = z.object({ email: emailSchema, password: z.string().min(1).max(72) });
const projectFields = z.object({ name: text(120).min(1), description: text(2000).optional().default(''), status: projectStatus.optional(), startDate: date, endDate: date });
const projectSchema = projectFields.refine(v => !v.startDate || !v.endDate || v.endDate >= v.startDate, { path: ['endDate'], message: 'End date must be on or after start date' });
const projectUpdateSchema = projectFields.partial().refine(v => !v.startDate || !v.endDate || v.endDate >= v.startDate, { path: ['endDate'], message: 'End date must be on or after start date' });
const taskSchema = z.object({ name: text(160).min(1), description: text(2000).optional().default(''), priority: priority.optional(), status: taskStatus.optional(), dueDate: date, projectId: z.string().min(1).optional() });
const safeUser = (user: { id: string; fullName: string; email: string; createdAt: Date }) => user;
const createToken = (userId: string) => jwt.sign({}, process.env.JWT_SECRET!, { subject: userId, expiresIn: (process.env.JWT_EXPIRES_IN || '7d') as jwt.SignOptions['expiresIn'] });

app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));
app.post('/api/auth/register', authLimit, async (req, res, next) => {
  try {
    const data = parse(registerSchema, req.body);
    const passwordHash = await bcrypt.hash(data.password, 12);
    const user = await prisma.user.create({ data: { fullName: data.fullName, email: data.email, passwordHash }, select: { id: true, fullName: true, email: true, createdAt: true } });
    const token = createToken(user.id);
    res.status(201).json({ token, user: safeUser(user) });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return res.status(409).json({ error: 'An account with this email already exists' });
    next(e);
  }
});
app.post('/api/auth/login', authLimit, async (req, res, next) => {
  try {
    const data = parse(loginSchema, req.body);
    const user = await prisma.user.findUnique({ where: { email: data.email } });
    if (!user || !(await bcrypt.compare(data.password, user.passwordHash))) return res.status(401).json({ error: 'Email or password is incorrect' });
    const token = createToken(user.id);
    res.json({ token, user: safeUser(user) });
  } catch (e) { next(e); }
});
app.post('/api/auth/logout', authenticate, (_req, res) => res.json({ message: 'Logged out. Discard the access token on this device.' }));
app.get('/api/auth/me', authenticate, async (req, res, next) => {
  try { const user = await prisma.user.findUnique({ where: { id: req.userId! }, select: { id: true, fullName: true, email: true, createdAt: true } }); if (!user) return res.status(401).json({ error: 'Account not found' }); res.json({ user }); } catch (e) { next(e); }
});

app.use('/api', authenticate);
app.get('/api/projects', async (req, res, next) => {
  try {
    const where: Prisma.ProjectWhereInput = { userId: req.userId };
    if (req.query.status && Object.values(ProjectStatus).includes(req.query.status as ProjectStatus)) where.status = req.query.status as ProjectStatus;
    if (typeof req.query.search === 'string' && req.query.search.trim()) where.name = { contains: req.query.search.trim(), mode: 'insensitive' };
    const projects = await prisma.project.findMany({ where, include: { tasks: { orderBy: { createdAt: 'desc' } } }, orderBy: { updatedAt: 'desc' } });
    res.json({ projects });
  } catch (e) { next(e); }
});
app.get('/api/projects/:id', async (req, res, next) => {
  try { const project = await prisma.project.findFirst({ where: { id: req.params.id, userId: req.userId }, include: { tasks: { orderBy: { createdAt: 'desc' } } } }); if (!project) return res.status(404).json({ error: 'Project not found' }); res.json({ project }); } catch (e) { next(e); }
});
app.post('/api/projects', async (req, res, next) => {
  try { const data = parse(projectSchema, req.body); const project = await prisma.project.create({ data: { ...data, userId: req.userId! } }); res.status(201).json({ project }); } catch (e) { next(e); }
});
app.put('/api/projects/:id', async (req, res, next) => {
  try { const data = parse(projectUpdateSchema, req.body); const result = await prisma.project.updateMany({ where: { id: req.params.id, userId: req.userId }, data }); if (!result.count) return res.status(404).json({ error: 'Project not found' }); const project = await prisma.project.findUnique({ where: { id: req.params.id }, include: { tasks: true } }); res.json({ project }); } catch (e) { next(e); }
});
app.delete('/api/projects/:id', async (req, res, next) => {
  try { const result = await prisma.project.deleteMany({ where: { id: req.params.id, userId: req.userId } }); if (!result.count) return res.status(404).json({ error: 'Project not found' }); res.status(204).end(); } catch (e) { next(e); }
});

app.get('/api/tasks', async (req, res, next) => {
  try {
    const where: Prisma.TaskWhereInput = { project: { userId: req.userId } };
    if (req.query.projectId) where.projectId = String(req.query.projectId);
    if (req.query.status && Object.values(TaskStatus).includes(req.query.status as TaskStatus)) where.status = req.query.status as TaskStatus;
    if (req.query.priority && Object.values(Priority).includes(req.query.priority as Priority)) where.priority = req.query.priority as Priority;
    if (typeof req.query.search === 'string' && req.query.search.trim()) where.name = { contains: req.query.search.trim(), mode: 'insensitive' };
    const tasks = await prisma.task.findMany({ where, include: { project: { select: { id: true, name: true } } }, orderBy: [{ dueDate: 'asc' }, { createdAt: 'desc' }] });
    res.json({ tasks });
  } catch (e) { next(e); }
});
app.get('/api/tasks/:id', async (req, res, next) => {
  try { const task = await prisma.task.findFirst({ where: { id: req.params.id, project: { userId: req.userId } }, include: { project: { select: { id: true, name: true } } } }); if (!task) return res.status(404).json({ error: 'Task not found' }); res.json({ task }); } catch (e) { next(e); }
});
app.post('/api/tasks', async (req, res, next) => {
  try {
    const data = parse(taskSchema.required({ projectId: true }), req.body);
    const owned = await prisma.project.findFirst({ where: { id: data.projectId, userId: req.userId }, select: { id: true } });
    if (!owned) return res.status(404).json({ error: 'Project not found' });
    const task = await prisma.task.create({ data: { ...data, projectId: data.projectId }, include: { project: { select: { id: true, name: true } } } }); res.status(201).json({ task });
  } catch (e) { next(e); }
});
app.put('/api/tasks/:id', async (req, res, next) => {
  try {
    const data = parse(taskSchema.omit({ projectId: true }).partial().extend({ projectId: z.string().min(1).optional() }), req.body);
    if (data.projectId) { const owned = await prisma.project.findFirst({ where: { id: data.projectId, userId: req.userId }, select: { id: true } }); if (!owned) return res.status(404).json({ error: 'Project not found' }); }
    const result = await prisma.task.updateMany({ where: { id: req.params.id, project: { userId: req.userId } }, data });
    if (!result.count) return res.status(404).json({ error: 'Task not found' });
    const task = await prisma.task.findUnique({ where: { id: req.params.id }, include: { project: { select: { id: true, name: true } } } }); res.json({ task });
  } catch (e) { next(e); }
});
app.delete('/api/tasks/:id', async (req, res, next) => {
  try { const result = await prisma.task.deleteMany({ where: { id: req.params.id, project: { userId: req.userId } } }); if (!result.count) return res.status(404).json({ error: 'Task not found' }); res.status(204).end(); } catch (e) { next(e); }
});
app.get('/api/dashboard', async (req, res, next) => {
  try {
    const [totalProjects, projectsInProgress, totalTasks, completedTasks, pendingTasks] = await Promise.all([
      prisma.project.count({ where: { userId: req.userId } }),
      prisma.project.count({ where: { userId: req.userId, status: ProjectStatus.IN_PROGRESS } }),
      prisma.task.count({ where: { project: { userId: req.userId } } }),
      prisma.task.count({ where: { status: TaskStatus.COMPLETED, project: { userId: req.userId } } }),
      prisma.task.count({ where: { status: TaskStatus.PENDING, project: { userId: req.userId } } })
    ]);
    res.json({ totalProjects, totalTasks, completedTasks, pendingTasks, projectsInProgress });
  } catch (e) { next(e); }
});

app.use(errors);
export default app;
