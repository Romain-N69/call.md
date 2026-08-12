async function displayStreams(desktopCapturer) {
  const [screen] = await desktopCapturer.getSources({ types: ['screen'] });
  if (!screen) throw new Error('No screen is available for system audio capture');
  return { video: screen, audio: 'loopback' };
}

module.exports = { displayStreams };
