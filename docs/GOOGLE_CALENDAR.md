# Google Agenda somente leitura

O painel mostra eventos do Google Agenda junto aos compromissos manuais. Os compromissos manuais continuam separados. Só uma fonte Google fica ativa de cada vez, evitando eventos duplicados. Nenhuma forma de conexão cria, edita ou exclui dados no Google ou acessa o Gmail.

## Configurar iCal

Abra **Google Agenda** abaixo de “Na sua agenda”. A interface atual oferece o endereço secreto iCal como forma de conexão.

### Endereço secreto iCal

1. No Google Agenda, abra **Configurações**.
2. Em **Configurações das minhas agendas**, selecione a agenda desejada e abra **Integrar agenda**.
3. Copie **Endereço secreto no formato iCal**. Não use o endereço público nem compartilhe o endereço secreto: quem o tiver pode ler o feed.
4. Cole no painel e escolha **Salvar e consultar agenda**.

Essa forma funciona sem configurar um projeto Google Cloud Console.

As rotas OAuth anteriores e o escopo somente leitura permanecem no código, mas essa conexão não aparece na interface atual. Ela ainda exigiria credenciais de um projeto Google Cloud do desenvolvedor; não é necessária para configurar iCal.

## Armazenamento e atualização

O endereço iCal fica cifrado com AES-256-GCM no SQLite local, na tabela de metadados, usando a chave de 32 bytes em `data/.google-calendar.key` com permissão `0600`. A chave é criada automaticamente e `data/` é ignorada pelo Git. A infraestrutura OAuth anterior também usa proteção local. `GOOGLE_TOKEN_ENCRYPTION_KEY` ou `GOOGLE_TOKEN_KEY_FILE` podem fornecer a chave, caso configurados. Inclua a chave e o banco em backups protegidos. O iCal nunca é devolvido em respostas da API; **Remover endereço salvo** apaga o segredo local. Para revogá-lo no Google, gere um novo endereço secreto nas configurações do calendário. Desconectar OAuth remove os tokens locais e tenta revogar a autorização.

Os eventos são consultados ao abrir o painel, ao voltar para a janela, a cada 15 minutos enquanto o painel permanece aberto e pelo botão **Atualizar**. O feed iCal é publicado periodicamente pelo Google e pode atrasar em relação às mudanças no calendário; não há webhook nem atualização instantânea. O parser iCal trata recorrências, exceções, fusos e eventos de dia inteiro. O horário é mostrado na zona local de Belém.

A consulta iCal aceita somente HTTPS do host `calendar.google.com` no formato de endereço secreto, valida redirecionamentos, limita cada consulta a 8 segundos e a resposta a 2 MiB. Erros de acesso/feed aparecem separados de “nenhum evento”. A URL secreta não aparece em logs ou respostas da API.

Documentação oficial:

- [Endereço secreto e integração de agenda](https://support.google.com/calendar/answer/37648?hl=pt-BR)

Os testes usam somente URLs e eventos fictícios; nenhuma conta ou feed real foi consultado.
