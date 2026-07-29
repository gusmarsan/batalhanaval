# Batalha Naval — duelo online

Jogo de Batalha Naval para duas pessoas, publicado como site estático no GitHub Pages e sincronizado em tempo real pelo Firebase.

## Regras desta versão

- Tabuleiro 10 × 10
- 1 porta-aviões de 5 casas
- 1 encouraçado de 4 casas
- 1 cruzador de 3 casas
- 2 contratorpedeiros de 2 casas
- 2 submarinos de 1 casa
- Um tiro por turno
- Salas privadas com código no formato `MAR-482`
- Posicionamento manual ou automático
- Revanche na mesma sala

## Firebase usado

O `app.js` já contém a configuração pública do projeto `app-meu-patrimonio-gus`.

No Firebase Console:

1. Abra **Authentication > Sign-in method**.
2. Ative o provedor **Anônimo**.
3. Em **Authentication > Settings > Authorized domains**, confirme `gusmarsan.github.io`.
4. Abra **Firestore Database > Rules**.
5. Substitua as regras pelo conteúdo de `firestore.rules` e publique.

O arquivo já reúne duas áreas: `users`, usada pelos aplicativos pessoais anteriores, e `battleshipRooms`, usada pelo jogo. Assim, a publicação não remove o isolamento dos dados do app Meu Patrimônio.

## Publicar no GitHub Pages

1. Crie um repositório, por exemplo `batalha-naval`.
2. Envie todos os arquivos desta pasta para a raiz do repositório.
3. Abra **Settings > Pages**.
4. Em **Build and deployment**, escolha **Deploy from a branch**.
5. Selecione a branch `main` e a pasta `/root`.
6. O endereço ficará parecido com `https://gusmarsan.github.io/batalha-naval/`.

## Testar

1. Abra o site em um navegador e crie uma sala.
2. Copie o código.
3. Abra o endereço em outro navegador, perfil ou aparelho.
4. Entre com o código e escolha outro nome.
5. Posicione as frotas e confirme nos dois aparelhos.

## Estrutura de segurança

- O documento principal da sala guarda jogadores, turno, estado e placar.
- A frota fica em um documento privado, legível somente pelo próprio jogador.
- Um tiro é criado como pendente pelo atacante.
- O aparelho do defensor confere a própria frota e publica apenas o resultado: água, acerto ou afundou.

Essa arquitetura evita que a posição dos navios apareça diretamente para o adversário. Como é um jogo sem servidor próprio ou Cloud Functions, as regras são adequadas para partidas casuais entre pessoas convidadas, não para competições com premiação.
