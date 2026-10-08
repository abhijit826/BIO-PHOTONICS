import app from './app';
import { prisma } from './db';

const port = Number(process.env.PORT || 4000);
const server = app.listen(port, () => console.log(`TaskFlow API listening on http://localhost:${port}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(async () => { await prisma.$disconnect(); process.exit(0); }));
