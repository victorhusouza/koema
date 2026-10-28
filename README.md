# Koema

Painel pessoal com briefing diário, tarefas, projetos e agenda, feito com Next.js, TypeScript e SQLite.

## Executar localmente

Requer Node.js 24 ou superior.

```sh
npm ci
npm run dev
```

Abra http://127.0.0.1:3000/prototype. O servidor escuta apenas no computador local.

## Funcionalidades

- Tarefas com notas, checklist, datas, prazos, Hoje, Upcoming e Logbook.
- Áreas, projetos e Algum dia.
- Recorrências diárias, semanais e mensais, com ajuste para o último dia disponível em meses curtos.
- Briefings por data com histórico e salvamento automático.
- Compromissos manuais e Google Agenda por endereço secreto iCal, somente leitura, com Hoje e Amanhã.

Veja [como configurar a agenda](docs/GOOGLE_CALENDAR.md).

## Dados locais

O banco e a chave de criptografia ficam em `data/`, fora do Git. Arquivos `.env` também não são publicados. Novas instalações usam dados de demonstração. O aplicativo ainda não tem autenticação: mantenha o acesso restrito ao computador até preparar a hospedagem.

## Verificação

```sh
npm test
npm run typecheck
npm run build
```

Backup/restauração e hospedagem são etapas futuras.
