define([
    'events/events',
    'events/states',
    'utils/backbone.events',
    'utils/constants',
    'utils/helpers',
    'utils/underscore',
    'view/controls/components/button',
    'view/controls/controlbar',
    'view/controls/dock',
    'view/controls/display-container',
    'view/controls/rewind-display-icon',
    'view/controls/play-display-icon',
    'view/controls/next-display-icon',
    'view/controls/nextuptooltip',
    'view/controls/rightclick',
], function (events, states, Events, Constants, utils, _, button, Controlbar, Dock,
             DisplayContainer, RewindDisplayIcon, PlayDisplayIcon, NextDisplayIcon,
             NextUpToolTip, RightClick) {

    const ACTIVE_TIMEOUT = utils.isMobile() ? 4000 : 2000;
    const CONTOLBAR_ONLY_HEIGHT = 44;

    const isAudioMode = function(model) {
        const playerHeight = model.get('height');
        if (model.get('aspectratio')) {
            return false;
        }
        if (typeof playerHeight === 'string' && playerHeight.indexOf('%') > -1) {
            return false;
        }

        // Coerce into Number (don't parse out CSS units)
        let verticalPixels = (playerHeight * 1) || NaN;
        verticalPixels = (!isNaN(verticalPixels) ? verticalPixels : model.get('containerHeight'));
        if (!verticalPixels) {
            return false;
        }

        return verticalPixels && verticalPixels <= CONTOLBAR_ONLY_HEIGHT;
    };

    const reasonInteraction = function() {
        return { reason: 'interaction' };
    };

    require('css/controls.less');

    return class Controls {
        constructor(context, playerContainer) {
            _.extend(this, Events);

            // Alphabetic order
            // Any property on the prototype should be initialized here first
            this.activeTimeout = -1;
            this.context = context;
            this.controlbar = null;
            this.displayContainer = null;
            this.dock = null;
            this.enabled = true;
            this.instreamState = null;
            this.keydownCallback = null;
            this.mute = null;
            this.nextUpToolTip = null;
            this.playerContainer = playerContainer;
            this.rightClickMenu = null;
            this.showing = false;
            this.unmuteCallback = null;
            this.element = null;
            this.right = null;
            this.activeListeners = {
                mousemove: () => clearTimeout(this.activeTimeout),
                mouseout: () => this.userActive()
            };
        }

        enable(api, model) {
            const element = this.context.createElement('div');
            element.className = 'jw-controls jw-reset';
            this.element = element;

            const right = this.context.createElement('div');
            right.className = 'jw-controls-right jw-reset';
            element.appendChild(right);
            this.right = right;

            // Dock Area and Buttons
            if (!this.dock) {
                this.dock = new Dock(model);
            }
            this.right.appendChild(this.dock.element());

            // Display Buttons
            if (!this.displayContainer) {
                const displayContainer = new DisplayContainer();
                const rewindDisplayIcon = new RewindDisplayIcon(model, api);
                const playDisplayIcon = new PlayDisplayIcon(model);
                const nextDisplayIcon = new NextDisplayIcon(model, api);

                // toggle playback
                playDisplayIcon.on('click tap', () => {
                    this.trigger(events.JWPLAYER_DISPLAY_CLICK);
                    this.userActive(1000);
                    api.play(reasonInteraction());
                });
                // make playDisplayIcon clickthrough on chrome for flash to avoid power safe throttle
                if (utils.isChrome() && !utils.isMobile()) {
                    playDisplayIcon.el.addEventListener('mousedown', () => {
                        const provider = model.getVideo();
                        const isFlash = (provider && provider.getName().name.indexOf('flash') === 0);
                        if (!isFlash) {
                            return;
                        }
                        const resetPointerEvents = () => {
                            this.context.removeEventListener('mouseup', resetPointerEvents);
                            playDisplayIcon.el.style.pointerEvents = 'auto';
                        };
                        this.style.pointerEvents = 'none';
                        this.context.addEventListener('mouseup', resetPointerEvents);
                    });
                }
                displayContainer.addButton(rewindDisplayIcon);
                displayContainer.addButton(playDisplayIcon);
                displayContainer.addButton(nextDisplayIcon);

                this.element.appendChild(displayContainer.element());
                this.displayContainer = displayContainer;
            }

            // Touch UI mode when we're on mobile and we have a percentage height or we can fit the large UI in
            const height = model.get('height');
            if (utils.isMobile() && (typeof height === 'string' || height >= CONTOLBAR_ONLY_HEIGHT)) {
                utils.addClass(this.playerContainer, 'jw-flag-touch');
            } else {
                this.rightClickMenu = new RightClick();
                this.rightClickMenu.setup(model, this.playerContainer, this.playerContainer);
            }

            // Next Up Tooltip
            if (model.get('nextUpDisplay') && !this.nextUpToolTip) {
                const nextUpToolTip = new NextUpToolTip(model, api, this.playerContainer);
                nextUpToolTip.setup(this.context);
                this.nextUpToolTip = nextUpToolTip;

                // NextUp needs to be behind the controlbar to not block other tooltips
                this.element.appendChild(nextUpToolTip.element());
            }

            // Controlbar
            if (!this.controlbar) {
                this.controlbar = new Controlbar(api, model);
                this.controlbar.on(events.JWPLAYER_USER_ACTION, () => this.userActive());
            }
            this.addActiveListeners(this.controlbar.element());
            this.element.appendChild(this.controlbar.element());

            // Unmute Autoplay Button. Ignore iOS9. Muted autoplay is supported in iOS 10+
            if (model.get('autostartMuted')) {
                const unmuteCallback = () => this.unmuteAutoplay(api, model);
                this.mute = button('jw-autostart-mute jw-off', unmuteCallback, model.get('localization').volume);
                this.mute.show();
                this.element.appendChild(this.mute.element());
                // Set mute state in the controlbar
                this.controlbar.renderVolume(true, model.get('volume'));
                // Hide the controlbar until the autostart flag is removed
                utils.addClass(this.playerContainer, 'jw-flag-autostart');

                model.on('change:autostartFailed change:autostartMuted change:mute', unmuteCallback);
                this.unmuteCallback = unmuteCallback;
            }

            // Keyboard Commands
            function adjustSeek(amount) {
                let min = 0;
                let max = model.get('duration');
                const position = model.get('position');
                if (model.get('streamType') === 'DVR') {
                    min = max;
                    max = Math.max(position, Constants.dvrSeekLimit);
                }
                const newSeek = utils.between(position + amount, min, max);
                api.seek(newSeek, reasonInteraction());
            }
            function adjustVolume(amount) {
                const newVol = utils.between(model.get('volume') + amount, 0, 100);
                api.setVolume(newVol);
            }
            const handleKeydown = (evt) => {
                // If Meta keys return
                if (evt.ctrlKey || evt.metaKey) {
                    // Let event bubble upwards
                    return true;
                }
                // On keypress show the controlbar for a few seconds
                if (!this.instreamState) {
                    this.userActive();
                }
                switch (evt.keyCode) {
                    case 27: // Esc
                        api.setFullscreen(false);
                        break;
                    case 13: // enter
                    case 32: // space
                        api.play(reasonInteraction());
                        break;
                    case 37: // left-arrow, if not adMode
                        if (!this.instreamState) {
                            adjustSeek(-5);
                        }
                        break;
                    case 39: // right-arrow, if not adMode
                        if (!this.instreamState) {
                            adjustSeek(5);
                        }
                        break;
                    case 38: // up-arrow
                        adjustVolume(10);
                        break;
                    case 40: // down-arrow
                        adjustVolume(-10);
                        break;
                    case 67: // c-key
                        {
                            const captionsList = api.getCaptionsList();
                            const listLength = captionsList.length;
                            if (listLength) {
                                const nextIndex = (api.getCurrentCaptions() + 1) % listLength;
                                api.setCurrentCaptions(nextIndex);
                            }
                        }
                        break;
                    case 77: // m-key
                        api.setMute();
                        break;
                    case 70: // f-key
                        api.setFullscreen();
                        break;
                    default:
                        if (evt.keyCode >= 48 && evt.keyCode <= 59) {
                            // if 0-9 number key, move to n/10 of the percentage of the video
                            const number = evt.keyCode - 48;
                            const newSeek = (number / 10) * model.get('duration');
                            api.seek(newSeek, reasonInteraction());
                        }
                }

                if (/13|32|37|38|39|40/.test(evt.keyCode)) {
                    // Prevent keypresses from scrolling the screen
                    evt.preventDefault();
                    return false;
                }
            };
            this.playerContainer.addEventListener('keydown', handleKeydown);
            this.keydownCallback = handleKeydown;

            // Show controls when enabled
            this.userActive();

            this.playerContainer.appendChild(this.element);
        }

        disable() {
            this.off();
            clearTimeout(this.activeTimeout);

            if (this.element.parentNode) {
                this.playerContainer.removeChild(this.element);
            }
            if (this.controlbar) {
                this.removeActiveListeners(this.controlbar.element());
            }
            if (this.rightClickMenu) {
                this.rightClickMenu.destroy();
                this.rightClickMenu = null;
            }

            if (this.keydownCallback) {
                this.playerContainer.removeEventListener('keydown', this.keydownCallback);
                this.keydownCallback = null;
            }
        }

        getElement() {
            return this.element;
        }

        resize(model, breakPoint) {
            const audioMode = isAudioMode(model);

            // Set timeslider flags
            const smallPlayer = breakPoint < 2;
            const timeSliderAboveConfig = model.get('timeSliderAbove');
            const timeSliderAbove = !audioMode &&
                (timeSliderAboveConfig !== false) && (timeSliderAboveConfig || smallPlayer);
            utils.toggleClass(this.playerContainer, 'jw-flag-small-player', smallPlayer);
            utils.toggleClass(this.playerContainer, 'jw-flag-audio-player', audioMode);
            utils.toggleClass(this.playerContainer, 'jw-flag-time-slider-above', timeSliderAbove);

            model.set('audioMode', audioMode);
        }

        unmuteAutoplay(api, model) {
            const autostartSucceeded = !model.get('autostartFailed');
            let mute = model.get('mute');

            // If autostart succeeded, it means the user has chosen to unmute the video,
            // so we should update the model, setting mute to false
            if (autostartSucceeded) {
                mute = false;
            } else {
                // Don't try to play again when viewable since it will keep failing
                model.set('playOnViewable', false);
            }
            if (this.unmuteCallback) {
                model.off('change:autostartFailed change:autostartMuted change:mute', this.unmuteCallback);
                this.unmuteCallback = null;
            }
            model.set('autostartFailed', undefined);
            model.set('autostartMuted', undefined);
            api.setMute(mute);
            // the model's mute value may not have changed. ensure the controlbar's mute button is in the right state
            this.controlbar.renderVolume(mute, model.get('volume'));
            this.mute.hide();
            utils.removeClass(this.playerContainer, 'jw-flag-autostart');
        }

        addActiveListeners(element) {
            if (element && !utils.isMobile()) {
                element.addEventListener('mousemove', this.activeListeners.mousemove);
                element.addEventListener('mouseout', this.activeListeners.mouseout);
            }
        }

        removeActiveListeners(element) {
            if (element) {
                element.removeEventListener('mousemove', this.activeListeners.mousemove);
                element.removeEventListener('mouseout', this.activeListeners.mouseout);
            }
        }

        userActive(timeout) {
            clearTimeout(this.activeTimeout);
            this.activeTimeout = setTimeout(() => this.userInactive(),
                timeout || ACTIVE_TIMEOUT);
            if (!this.showing) {
                utils.removeClass(this.playerContainer, 'jw-flag-user-inactive');
                this.showing = true;
                this.trigger('userActive', this.showing);
            }
        }

        userInactive() {
            clearTimeout(this.activeTimeout);
            this.showing = false;
            if (this.controlbar) {
                this.controlbar.hideComponents();
            }
            utils.addClass(this.playerContainer, 'jw-flag-user-inactive');
            this.trigger('userInactive', this.showing);
        }
    };
});
