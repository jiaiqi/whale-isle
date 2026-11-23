/** dsh 形态插件：export default { name, apply(ctx) }；ctx 提供 tool/on/effect 三个能力。 */
export default {
  name: 'hello-whale',
  apply(ctx) {
    ctx.tool('hello_ping', (args) => ({ pong: true, who: args?.who ?? '小鲸' }));
    ctx.on('autodrive:event', (event) => {
      if (event?.type === 'decision') ctx.emit('hello:decision', { tool: event.tool });
    });
    ctx.effect(() => () => {}); // 返回的清理器在 disable 时执行
  },
};
