# Only for an iOS project made with --packagemanager CocoaPods. Capacitor 8
# makes Swift Package Manager projects by default, which read Package.swift.
Pod::Spec.new do |s|
  s.name = 'HalfstopAppleSignIn'
  s.version = '1.0.0'
  s.summary = 'Sign in with Apple for the Halfstop iPhone app'
  s.license = { :type => 'UNLICENSED' }
  s.homepage = 'https://app.halfstop.app'
  s.author = 'Halfstop'
  s.source = { :git => 'https://github.com/shermancahal/Halfstop.git', :tag => s.version.to_s }
  s.source_files = 'ios/Sources/**/*.swift'
  s.ios.deployment_target = '15.0'
  s.dependency 'Capacitor'
  s.swift_version = '5.9'
end
