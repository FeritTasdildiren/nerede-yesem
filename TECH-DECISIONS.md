# Teknoloji Kararları - Güncellenmiş

## Değişiklikler (2025-01-28)

### AI API
- ~~Claude 3.5 Sonnet~~ → **GPT-4o-mini**
- Sebep: Kullanıcı tercihi, mevcut API key

### Hosting
- ~~Vercel~~ → **Self-hosted (CloudPanel)**
- Server: 157.173.116.230
- Panel: cloud.skystonetech.com

### Kesinleşen Stack

| Katman | Teknoloji | Not |
|--------|-----------|-----|
| Frontend | Next.js 14 + TypeScript | Değişmedi |
| Styling | Tailwind + shadcn/ui | Değişmedi |
| Backend | Next.js API Routes | Değişmedi |
| AI/LLM | **GPT-4o-mini** | OpenAI API |
| Database | PostgreSQL | Sunucuda kurulacak |
| Cache | Redis | Sunucuda kurulacak |
| Hosting | **CloudPanel (Self-hosted)** | Node.js app olarak deploy |
| Domain | skystonetech.com altı | Kullanılabilir |
| Email | Mailcow | mail.skystonetech.com |

### Deployment Stratejisi
1. CloudPanel üzerinde Node.js site oluştur
2. GitHub → CloudPanel auto-deploy (webhook)
3. PostgreSQL + Redis sunucuda kur
4. SSL otomatik (Let's Encrypt)
5. PM2 ile process management
