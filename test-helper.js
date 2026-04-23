// CDP helper for sending a question and reading the response
// Usage: set globalThis.__question before calling
async function askAndRead(page, question) {
  const client = await page.context().newCDPSession(page);

  // Get fresh DOM
  const { root } = await client.send('DOM.getDocument', { depth: -1, pierce: true });
  const { nodeId: hostId } = await client.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#sql-chatbot-host' });
  const { node } = await client.send('DOM.describeNode', { nodeId: hostId, depth: -1, pierce: true });
  const { object: srObj } = await client.send('DOM.resolveNode', { backendNodeId: node.shadowRoots[0].backendNodeId });
  const { nodeId: srNodeId } = await client.send('DOM.requestNode', { objectId: srObj.objectId });

  // Type question
  const { nodeId: inputId } = await client.send('DOM.querySelector', { nodeId: srNodeId, selector: 'input' });
  await client.send('DOM.focus', { nodeId: inputId });
  await page.keyboard.type(question);

  // Click Send
  const { nodeIds: btnIds } = await client.send('DOM.querySelectorAll', { nodeId: srNodeId, selector: 'button' });
  for (const bid of btnIds) {
    const { object } = await client.send('DOM.resolveNode', { nodeId: bid });
    const { result } = await client.send('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: 'function() { return this.textContent.trim(); }' });
    if (result.value === 'Send') {
      const { model } = await client.send('DOM.getBoxModel', { nodeId: bid });
      const cc = model.content;
      await page.mouse.click((cc[0]+cc[2]+cc[4]+cc[6])/4, (cc[1]+cc[3]+cc[5]+cc[7])/4);
      break;
    }
  }

  // Wait for response
  await new Promise(f => setTimeout(f, 12000));

  // Read response
  const { root: r2 } = await client.send('DOM.getDocument', { depth: -1, pierce: true });
  const { nodeId: h2 } = await client.send('DOM.querySelector', { nodeId: r2.nodeId, selector: '#sql-chatbot-host' });
  const { node: n2 } = await client.send('DOM.describeNode', { nodeId: h2, depth: -1, pierce: true });
  const { object: sr2 } = await client.send('DOM.resolveNode', { backendNodeId: n2.shadowRoots[0].backendNodeId });
  const { nodeId: sn2 } = await client.send('DOM.requestNode', { objectId: sr2.objectId });
  const msgs = await client.send('DOM.querySelectorAll', { nodeId: sn2, selector: 'p, div > span, li' });
  let texts = [];
  for (const mid of msgs.nodeIds) {
    try {
      const { object } = await client.send('DOM.resolveNode', { nodeId: mid });
      const { result } = await client.send('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: 'function() { return this.innerText || this.textContent; }' });
      if (result.value && result.value.trim().length > 3) texts.push(result.value.trim());
    } catch(e) {}
  }
  return texts.slice(-3).join('\n---\n');
}

module.exports = { askAndRead };
