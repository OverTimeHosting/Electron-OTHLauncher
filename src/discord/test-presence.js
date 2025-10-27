const DiscordRPC = require('discord-rpc');

const clientId = '1348861044604534835'; // Your Discord Application ID

console.log('🔍 Testing Discord Rich Presence...\n');
console.log('Client ID:', clientId);
console.log('Make sure Discord is running!\n');

const client = new DiscordRPC.Client({ transport: 'ipc' });

client.on('ready', async () => {
  console.log('✅ Connected to Discord as:', client.user.username);
  console.log('👤 Discord User ID:', client.user.id);
  console.log('\n🎉 Discord RPC is working!\n');
  
  console.log('📡 Setting test presence...');
  
  try {
    await client.setActivity({
      details: 'OTH Launcher - Test',
      state: 'Testing Rich Presence',
      startTimestamp: Date.now(),
    });
    
    console.log('✅ Presence set successfully!');
    console.log('\n👀 Check your Discord profile - you should see:');
    console.log('   Playing OTH Launcher - Test');
    console.log('   Testing Rich Presence');
    console.log('\n✨ Success! Your Discord Rich Presence is working!');
    console.log('\nPress Ctrl+C to exit...');
    
  } catch (error) {
    console.error('❌ Failed to set presence:', error.message);
  }
});

client.on('disconnected', () => {
  console.log('⚠️ Disconnected from Discord');
});

client.login({ clientId }).catch(error => {
  console.error('\n❌ Failed to connect to Discord:');
  console.error('   Error:', error.message);
  
  if (error.message.includes('Could not connect')) {
    console.log('\n💡 Troubleshooting:');
    console.log('   1. Make sure Discord is running');
    console.log('   2. Restart Discord');
    console.log('   3. Check if Discord is blocked by firewall');
  } else if (error.message.includes('Invalid Client ID')) {
    console.log('\n💡 The Discord Application ID might be invalid.');
    console.log('   Check: https://discord.com/developers/applications');
  }
  
  process.exit(1);
});

// Handle Ctrl+C
process.on('SIGINT', () => {
  console.log('\n\n👋 Exiting...');
  client.destroy();
  process.exit(0);
});
