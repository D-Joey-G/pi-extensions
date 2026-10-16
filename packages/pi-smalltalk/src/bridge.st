"Bridge between pi and this image. pi files it in on every start, then talks to it over HTTP on localhost.
Every request is a JSON POST carrying the token from PI_SMALLTALK_TOKEN; see PiBridge>>dispatch:."!

(Object << #PiTranscript
	slots: { #stream };
	tag: 'Bridge';
	package: 'PiBridge') install!

(Error << #PiCompileError
	tag: 'Bridge';
	package: 'PiBridge') install!

(Object << #PiWorkspace
	slots: { #bindings };
	tag: 'Bridge';
	package: 'PiBridge') install!

(Object << #PiBridge
	slots: { #server . #token . #workspace . #baseline . #pending . #interrupted };
	sharedVariables: { #Default };
	tag: 'Bridge';
	package: 'PiBridge') install!

!PiTranscript methodsFor: 'streaming'!
initialize
	stream := WriteStream on: (String new: 256)!
contents
	^ stream contents!
nextPutAll: aString
	stream nextPutAll: aString asString!
show: anObject
	stream nextPutAll: anObject asString!
crShow: anObject
	stream cr; nextPutAll: anObject asString!
nextPut: aCharacter
	stream nextPut: aCharacter!
<< anObject
	stream << anObject!
print: anObject
	stream print: anObject!
display: anObject
	stream nextPutAll: anObject displayString!
cr
	stream cr!
lf
	stream lf!
crlf
	stream cr!
tab
	stream tab!
space
	stream space!
crTab
	stream cr; tab!
flush!
endEntry!
clear!
doesNotUnderstand: aMessage
	^ aMessage sendTo: stream! !

!PiWorkspace methodsFor: 'compiler requestor'!
initialize
	bindings := Dictionary new!
bindings
	^ bindings!
bindingOf: aString
	"Assigning to an unknown name declares it, as in a Playground."
	(bindings includesKey: aString asSymbol)
		ifFalse: [ bindings add: (WorkspaceVariable key: aString asSymbol) ].
	^ bindings associationAt: aString asSymbol!
hasBindingOf: aString
	^ bindings includesKey: aString asSymbol!
canAddBindingOf: aString
	^ true!
isScripting
	^ true!
needRequestorScope
	^ true!
interactive
	^ false!
notify: message at: position in: source
	^ PiCompileError signal: message , ' at character ' , position printString! !

!PiBridge class methodsFor: 'running'!
default
	^ Default ifNil: [ Default := self new ]!
serveFromEnvironment
	| env |
	env := Smalltalk os environment.
	SessionManager default registerUserClassNamed: self name.
	self default
		startOn: (env at: 'PI_SMALLTALK_PORT') asNumber
		token: (env at: 'PI_SMALLTALK_TOKEN').
	Stdio stdout nextPutAll: 'PI-BRIDGE-READY'; lf; flush!
startUp: resuming
	"A saved image resumes the server process of the run that saved it, bound to a socket that no longer exists."
	resuming ifTrue: [ Default ifNotNil: [ :bridge | bridge abandonServer ] ]! !

!PiBridge methodsFor: 'server'!
startOn: port token: aString
	self abandonServer.
	token := aString.
	workspace ifNil: [ workspace := PiWorkspace new ].
	baseline ifNil: [
		baseline := (PackageOrganizer default packages collect: [ :each | each name ]) asSet.
		baseline add: 'PiBridge' ].
	server := (ZnServer on: port)
		bindingAddress: NetNameResolver loopBackAddress;
		delegate: (ZnValueDelegate with: [ :request | self handle: request ]);
		yourself.
	server start!
abandonServer
	server ifNotNil: [ :old | [ old stop: false ] on: Error do: [ :e | ] ].
	server := nil!
handle: request
	| reply |
	(request headers at: 'X-Pi-Token' ifAbsent: [ nil ]) = token
		ifFalse: [ ^ ZnResponse new statusLine: ZnStatusLine forbidden; yourself ].
	reply := [ self dispatch: (STONJSON fromString: request contents) ]
		on: Error
		do: [ :e | Dictionary new at: 'ok' put: false; at: 'error' put: (self describeError: e); yourself ].
	^ ZnResponse ok: (ZnEntity with: (STONJSON toString: reply) type: ZnMimeType applicationJson)!
dispatch: args
	| op |
	op := args at: 'op'.
	op = 'ping' ifTrue: [ ^ self opPing ].
	op = 'evaluate' ifTrue: [ ^ self opEvaluate: args ].
	op = 'defineClass' ifTrue: [ ^ self opDefineClass: args ].
	op = 'defineMethod' ifTrue: [ ^ self opDefineMethod: args ].
	op = 'inspect' ifTrue: [ ^ self opInspect: args ].
	op = 'interrupt' ifTrue: [ ^ self opInterrupt ].
	op = 'save' ifTrue: [ ^ self opSave ].
	op = 'quit' ifTrue: [ ^ self opQuit: args ].
	^ self error: 'Unknown op ' , op printString! !

!PiBridge methodsFor: 'running code'!
run: aBlock timeout: milliseconds
	"Run aBlock in its own process below the server's priority, so a runaway loop can still be timed out or interrupted."
	| done outcome log process stack |
	done := Semaphore new.
	log := PiTranscript new.
	interrupted := false.
	process := [
		outcome := [
			[ Dictionary new at: 'ok' put: true; at: 'value' put: (self withTranscript: log do: aBlock); yourself ]
				on: Warning
				do: [ :w | log cr; show: 'Warning: ' , w messageText asString. w resume: nil ] ]
			on: Error , Halt
			do: [ :e | Dictionary new at: 'ok' put: false; at: 'error' put: (self describeError: e); yourself ].
		done signal ] newProcess.
	process priority: Processor userBackgroundPriority; name: 'pi evaluation'.
	pending := done.
	process resume.
	done waitTimeoutMilliseconds: milliseconds.
	pending := nil.
	outcome ifNil: [
		stack := self stackFrom: process suspendedContext.
		process terminate.
		outcome := Dictionary new
			at: 'ok' put: false;
			at: 'error' put: (Dictionary new
				at: 'class' put: (interrupted ifTrue: [ 'Interrupted' ] ifFalse: [ 'Timeout' ]);
				at: 'description' put: (interrupted
					ifTrue: [ 'Interrupted by the user' ]
					ifFalse: [ 'Stopped after ' , milliseconds printString , ' ms' ]);
				at: 'stack' put: stack;
				yourself);
			yourself ].
	outcome at: 'transcript' put: log contents.
	^ outcome!
withTranscript: aTranscript do: aBlock
	| previous |
	previous := Smalltalk globals at: #Transcript.
	Smalltalk globals at: #Transcript put: aTranscript.
	^ aBlock ensure: [ Smalltalk globals at: #Transcript put: previous ]!
describeError: anException
	^ Dictionary new
		at: 'class' put: anException class name;
		at: 'description' put: anException description;
		at: 'stack' put: ((anException isKindOf: PiCompileError) | (anException isKindOf: OCCodeError)
			ifTrue: [ #() ]
			ifFalse: [ self stackFrom: anException signalerContext ]);
		yourself!
stackFrom: aContext
	| frames context |
	frames := OrderedCollection new.
	context := aContext.
	[ context notNil and: [ frames size < 20 and: [ (self isBoundary: context) not ] ] ] whileTrue: [
		frames add: context printString.
		context := context sender ].
	^ frames asArray!
isBoundary: aContext
	"Frames from here up belong to the bridge and the compiler, not to the code under evaluation."
	| receiver |
	receiver := aContext receiver.
	^ receiver == self or: [ (receiver isKindOf: OpalCompiler) or: [ receiver isKindOf: OCDoItSemanticScope ] ]!
describe: anObject
	^ Dictionary new
		at: 'class' put: anObject class printString;
		at: 'print' put: ([ anObject printStringLimitedTo: 20000 ]
			on: Error
			do: [ :e | 'a ' , anObject class name , ' (printString failed: ' , e description , ')' ]);
		yourself!
compiler
	^ Smalltalk compiler requestor: workspace; yourself! !

!PiBridge methodsFor: 'ops'!
opPing
	^ Dictionary new
		at: 'ok' put: true;
		at: 'version' put: Smalltalk version;
		at: 'image' put: Smalltalk imagePath;
		yourself!
opEvaluate: args
	| code |
	code := args at: 'code'.
	^ self
		run: [ self describe: (self compiler evaluate: code) ]
		timeout: (args at: 'timeoutMs')!
opDefineClass: args
	^ self
		run: [ | result class |
			result := Smalltalk compiler evaluate: (args at: 'source').
			class := (result respondsTo: #install) ifTrue: [ result install ] ifFalse: [ result ].
			class isClass ifFalse: [ self error: 'The source evaluated to ' , class printString , ', not a class' ].
			(args at: 'comment' ifAbsent: [ nil ]) ifNotNil: [ :comment | class comment: comment ].
			class definitionString ]
		timeout: (args at: 'timeoutMs')!
opDefineMethod: args
	^ self
		run: [ | class existing selector undeclared |
			class := self resolveClass: (args at: 'class').
			existing := class selectors asSet.
			undeclared := OrderedCollection new.
			selector := [
				class
					compile: (args at: 'source')
					classified: ((args at: 'protocol' ifAbsent: [ nil ]) ifNil: [ 'as yet unclassified' ]) ]
				on: OCUndeclaredVariableWarning
				do: [ :warning | undeclared add: warning node name. warning pass ].
			String streamContents: [ :out |
				out
					nextPutAll: ((existing includes: selector) ifTrue: [ 'Replaced ' ] ifFalse: [ 'Added ' ]);
					nextPutAll: class name; nextPutAll: '>>#'; nextPutAll: selector.
				undeclared ifNotEmpty: [
					out nextPutAll: '. Warning: undeclared '.
					undeclared asSet asSortedCollection do: [ :each | out nextPutAll: each ] separatedBy: [ out nextPutAll: ', ' ].
					out nextPutAll: ' (bound to Undeclared, nil until defined)' ] ] ]
		timeout: (args at: 'timeoutMs')!
opInspect: args
	^ self
		run: [ | kind name |
			kind := args at: 'kind'.
			name := args at: 'name' ifAbsent: [ '' ].
			String streamContents: [ :out | self inspect: kind named: name on: out ] ]
		timeout: (args at: 'timeoutMs')!
opInterrupt
	interrupted := true.
	pending ifNotNil: [ :semaphore | semaphore signal ].
	^ Dictionary new at: 'ok' put: true; yourself!
opSave
	"The process that saved resumes when the saved image starts again, with no one to answer."
	| snapshot |
	snapshot := Smalltalk snapshot: true andQuit: false.
	snapshot isImageStarting ifTrue: [ Processor terminateActive ].
	snapshot hasError ifTrue: [ self error: 'Saving the image failed: ' , snapshot error description ].
	^ Dictionary new at: 'ok' put: true; yourself!
opQuit: args
	| save |
	save := args at: 'save' ifAbsent: [ true ].
	[ (Delay forMilliseconds: 100) wait. Smalltalk snapshot: save andQuit: true ] forkAt: Processor userSchedulingPriority.
	^ Dictionary new at: 'ok' put: true; yourself! !

!PiBridge methodsFor: 'inspecting'!
resolveClass: aString
	| parts class |
	parts := aString substrings.
	class := Smalltalk globals at: parts first asSymbol ifAbsent: [ nil ].
	(class notNil and: [ class isClassOrTrait ]) ifFalse: [ self error: 'No class named ' , parts first ].
	^ (parts size > 1 and: [ parts second = 'class' ]) ifTrue: [ class classSide ] ifFalse: [ class ]!
inspect: kind named: name on: out
	kind = 'overview' ifTrue: [ ^ self overviewOn: out ].
	kind = 'class' ifTrue: [ ^ self describeClass: (self resolveClass: name) on: out ].
	kind = 'method' ifTrue: [ ^ self describeMethod: name on: out ].
	kind = 'package' ifTrue: [ ^ self describePackage: name on: out ].
	kind = 'implementors' ifTrue: [ ^ self list: (SystemNavigation default allImplementorsOf: name asSymbol) on: out ].
	kind = 'senders' ifTrue: [ ^ self list: (SystemNavigation default allSendersOf: name asSymbol) on: out ].
	kind = 'references' ifTrue: [
		^ self
			list: (SystemNavigation default allReferencesTo: (Smalltalk globals associationAt: name asSymbol))
			on: out ].
	kind = 'search' ifTrue: [ ^ self search: name on: out ].
	kind = 'object' ifTrue: [ ^ self describeObject: (self compiler evaluate: name) on: out ].
	self error: 'Unknown kind ' , kind printString!
userPackages
	^ (PackageOrganizer default packages reject: [ :each | baseline includes: each name ])
		asSortedCollection: [ :a :b | a name <= b name ]!
overviewOn: out
	| packages |
	out nextPutAll: Smalltalk version; nextPutAll: ', image '; nextPutAll: Smalltalk imagePath; cr; cr.
	packages := self userPackages.
	packages
		ifEmpty: [ out nextPutAll: 'No packages beyond the base image yet.'; cr ]
		ifNotEmpty: [
			out nextPutAll: 'Packages added in this image:'; cr.
			packages do: [ :package |
				out nextPutAll: '  '; nextPutAll: package name; nextPutAll: ': '.
				(package definedClasses collect: [ :each | each name ]) asSortedCollection
					do: [ :each | out nextPutAll: each ]
					separatedBy: [ out nextPutAll: ', ' ].
				out cr ] ].
	out cr.
	workspace bindings
		ifEmpty: [ out nextPutAll: 'No workspace variables.' ]
		ifNotEmpty: [ :bindings |
			out nextPutAll: 'Workspace variables:'; cr.
			(bindings keys asSortedCollection: [ :a :b | a <= b ]) do: [ :key |
				out nextPutAll: '  '; nextPutAll: key; nextPutAll: ' = '.
				out nextPutAll: (([ (bindings at: key) value printStringLimitedTo: 100 ]
					on: Error do: [ :e | '<printString failed>' ])).
				out cr ] ]!
describeClass: class on: out
	out nextPutAll: class instanceSide definitionString; cr; cr.
	class instanceSide comment ifNotNil: [ :comment |
		comment ifNotEmpty: [ out nextPutAll: '"'; nextPutAll: comment; nextPutAll: '"'; cr; cr ] ].
	out nextPutAll: 'Superclasses: '.
	class instanceSide allSuperclasses
		do: [ :each | out nextPutAll: each name ]
		separatedBy: [ out nextPutAll: ' < ' ].
	out cr.
	class instanceSide subclasses ifNotEmpty: [ :subclasses |
		out nextPutAll: 'Subclasses: '.
		(subclasses collect: [ :each | each name ]) asSortedCollection
			do: [ :each | out nextPutAll: each ]
			separatedBy: [ out nextPutAll: ', ' ].
		out cr ].
	self methodsOf: class instanceSide titled: 'Instance side' on: out.
	self methodsOf: class classSide titled: 'Class side' on: out!
methodsOf: behavior titled: title on: out
	behavior selectors ifEmpty: [ ^ self ].
	out cr; nextPutAll: title; nextPutAll: ':'; cr.
	(behavior protocolNames asSortedCollection: [ :a :b | a <= b ]) do: [ :protocol |
		out nextPutAll: '  '; nextPutAll: protocol; nextPutAll: ': '.
		(behavior selectorsInProtocol: protocol) asSortedCollection
			do: [ :each | out nextPutAll: each ]
			separatedBy: [ out nextPutAll: ' ' ].
		out cr ]!
describeMethod: name on: out
	| index class selector |
	index := name indexOfSubCollection: '>>'.
	index = 0 ifTrue: [ self error: 'Name a method as Class>>selector or Class class>>selector' ].
	class := self resolveClass: (name first: index - 1).
	selector := (name allButFirst: index + 1) trimBoth.
	(selector beginsWith: '#') ifTrue: [ selector := selector allButFirst ].
	(class lookupSelector: selector asSymbol)
		ifNil: [ self error: class name , ' does not understand #' , selector ]
		ifNotNil: [ :method |
			out
				nextPutAll: '"'; nextPutAll: method methodClass name; nextPutAll: '>>#'; nextPutAll: selector;
				nextPutAll: ' in protocol '; nextPutAll: method protocolName; nextPutAll: '"'; cr;
				nextPutAll: method sourceCode ]!
describePackage: name on: out
	| package |
	package := PackageOrganizer default packageNamed: name ifAbsent: [ self error: 'No package named ' , name ].
	out nextPutAll: 'Package '; nextPutAll: package name; cr.
	(package definedClasses asSortedCollection: [ :a :b | a name <= b name ]) do: [ :each |
		out nextPutAll: '  '; nextPutAll: each name; nextPutAll: ' < '; print: each superclass; cr ].
	package extensionMethods ifNotEmpty: [ :methods |
		out nextPutAll: 'Extension methods:'; cr.
		methods do: [ :each | out nextPutAll: '  '; print: each; cr ] ]!
list: methods on: out
	| sorted |
	sorted := (methods collect: [ :each | each printString ]) asSortedCollection.
	sorted ifEmpty: [ ^ out nextPutAll: 'None.' ].
	out print: sorted size; nextPutAll: ' found'; cr.
	(sorted first: (sorted size min: 200)) do: [ :each | out nextPutAll: each; cr ].
	sorted size > 200 ifTrue: [ out nextPutAll: '...' ]!
search: pattern on: out
	| needle classes selectors |
	needle := pattern asLowercase.
	classes := (Smalltalk globals allClassesAndTraits select: [ :each |
		each name asLowercase includesSubstring: needle ]) collect: [ :each | each name ].
	selectors := Set new.
	Smalltalk globals allClassesAndTraits do: [ :class |
		class selectors do: [ :each | (each asLowercase includesSubstring: needle) ifTrue: [ selectors add: each ] ] ].
	out nextPutAll: 'Classes ('; print: classes size; nextPutAll: '):'; cr.
	(classes asSortedCollection first: (classes size min: 100)) do: [ :each | out nextPutAll: '  '; nextPutAll: each; cr ].
	out nextPutAll: 'Selectors ('; print: selectors size; nextPutAll: '):'; cr.
	(selectors asSortedCollection first: (selectors size min: 100)) do: [ :each | out nextPutAll: '  '; nextPutAll: each; cr ]!
describeObject: anObject on: out
	| class |
	class := anObject class.
	out nextPutAll: 'a '; nextPutAll: class name; cr.
	out nextPutAll: (anObject printStringLimitedTo: 2000); cr.
	class allInstVarNames doWithIndex: [ :name :index |
		out nextPutAll: '  '; nextPutAll: name; nextPutAll: ': '.
		out nextPutAll: ((anObject instVarAt: index) printStringLimitedTo: 200); cr ].
	class isVariable ifTrue: [
		out nextPutAll: '  indexed slots: '; print: anObject basicSize; cr.
		1 to: (anObject basicSize min: 50) do: [ :index |
			out nextPutAll: '  ['; print: index; nextPutAll: '] '.
			out nextPutAll: ((anObject basicAt: index) printStringLimitedTo: 200); cr ] ]! !

PiBridge serveFromEnvironment!
