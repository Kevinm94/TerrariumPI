'use strict';

var globals = {
  websocket: null,
  connection: 'ws' + (location.protocol == 'https:' ? 's' : '') + '://' + location.host + '/live',
  temperature_indicator: 'C',
  gauges: [],
  webcams: [],
  graphs: {},
  graph_cache: 5 * 60,
  websocket_timer: null,
  online_timer: null,
  current_version: null
};

/**
 * Resize function without multiple trigger
 *
 * Usage:
 * $(window).smartresize(function(){
 *     // code here
 * });
 */
(function($,sr){
    // debouncing function from John Hann
    // http://unscriptable.com/index.php/2009/03/20/debouncing-javascript-methods/
    var debounce = function (func, threshold, execAsap) {
      var timeout;

        return function debounced () {
            var obj = this, args = arguments;
            function delayed () {
                if (!execAsap)
                    func.apply(obj, args);
                timeout = null;
            }

            if (timeout)
                clearTimeout(timeout);
            else if (execAsap)
                func.apply(obj, args);

            timeout = setTimeout(delayed, threshold || 100);
        };
    };

    // smartresize
    jQuery.fn[sr] = function(fn){  return fn ? this.bind('resize', debounce(fn)) : this.trigger(sr); };

})(jQuery,'smartresize');

function websocket_init(reconnect) {
  websocket_connect();

  globals.websocket.onopen = function(evt) {
    websocket_message({
      'type': 'client_init',
      'reconnect': reconnect
    });
  };

  globals.websocket.onmessage = function(evt) {
    online_updater();
    var data = JSON.parse(evt.data);
    switch (data.type) {
      case 'uptime':
        update_dashboard_uptime(data.data);
        break;
      case 'power_usage_water_flow':
        update_dashboard_power_usage(data.data.power);
        update_dashboard_water_flow(data.data.water);
        break;

      case 'environment':
        $.each(['heater', 'sprayer', 'light', 'cooler'], function(index, value) {
          update_dashboard_environment(value, data.data[value]);
        });
        break;
      case 'sensor_gauge':
        $.each(data.data, function(index, sensor) {
          sensor_gauge(sensor.id !== undefined ? sensor.id : index, sensor);
        });
        break;
      case 'power_switches':
        $.each(data.data, function(index, value) {
          update_power_switch(value.id, value);
        });
        break;
      case 'door_indicator':
        update_door_indicator(data.data);
        break;
      case 'update_weather':
        update_weather(data.data);
        break;
    }
  };
  globals.websocket.onclose = function(evt) {
    is_offline();
    clearInterval(globals.websocket_timer);
    globals.websocket_timer = setInterval(function() {
      websocket_init(true);
    }, 10 * 1000);
  };
}

function websocket_connect() {
  try {
    clearInterval(globals.websocket_timer);
    globals.websocket = null;
    globals.websocket = new WebSocket(globals.connection);
  } catch (error) {
    //console.log('websocket_connect', error);
  }
}

function websocket_message(message) {
  try {
    globals.websocket.send(JSON.stringify(message));
  } catch (error) {
    //console.log('websocket_message', error, message);
  }
}

function menu_click(url) {
  // Find the menu item that should be loaded
  var menu_item = $('a[href="' + url + '"]');
  // Exists?
  if (menu_item.length == 1) {
    // Get the parent menu item
    var parent_menu = menu_item.parent('li').parents('li');
    // If the parent menu is active, we are al ready on the right parent menu
    if (parent_menu.hasClass('active')) {
      // Parent menu is the same, so clear all active submenu's
      parent_menu.find('.child_menu li').removeClass('active');
    } else {
      // Open parent menu
      parent_menu.find('a:first').click();
    }
    // Trigger the click on the sub menu item
    menu_item.click();
  }
  // Make sure that the browser will not fire it's url loading event
  return false;
}

function load_page(url) {
  // If no url given, use the event trigger a href attribute
  if (typeof url != 'string') {
    url = this.href;
  }
  // Only process with some input
  if (url !== '') {
    // Load the data through AJAX
    $.get(url, function(data) {
      // Get the menu url so that jQuery can match
      var menu_url = $('<a/>').attr('href',url)[0].pathname.replace(/^[^\/]/,'/').substr(1);
      // Clear all submenu's that are not clicked
      $('.child_menu a[href!="' + menu_url + '"]').parent().removeClass('active');
      $('.child_menu a[href="' + menu_url + '"]').parent().addClass('active');
      // Put the content on the page
      $("#maincontent").html(data);

      $("#maincontent a").each(function(index,item){
        $(item).attr('title',$(item).text());
      });
      // Reload some theme settings per page
      reload_reload_theme();
      process_form();
    });
  }
  // Make sure the browser will not fire it's url loading event
  return false;
}

function process_form() {
  $('form').each(function() {
    $(this).on('submit', function() {
      var form = $(this);
      $.ajax({
        method: form.attr('method'),
        url: form.attr('action'),
        dataType: 'json',
        contentType: 'application/json',
        data: JSON.stringify(prepare_form_data(form))
      }).done(function(response) {
        if (response.ok) {
          new PNotify({
            type: 'success',
            title: response.title,
            text: response.message,
            nonblock: {
              nonblock: true
            },
            delay: 1000,
            mouse_reset: false,
            addclass: 'dark',
            styling: 'bootstrap3',
            hide: true,
          });
        }
      });
      return false;
    });
  });
}

function prepare_form_data(form) {
  var formdata = [];
  var form_type = form.attr('action').split('/').pop();
  var re = /(sensor|switch|webcam|light|sprayer|heater|cooler|door)(_\d+)?_(.*)/i;
  var matches = null;
  var objectdata = {};
  var prev_nr = -1;
  if (form_type === 'weather' || form_type === 'environment' || form_type === 'system') {
    formdata = {};
  }
  try {
    form.find('div:visible input:not([disabled="disabled"]),div:visible select:not([disabled="disabled"])').each(function() {
      var field_name = $(this).attr('name');
      var field_value = $(this).val();
      switch (form_type) {
        case 'weather':
        case 'system':
          formdata[field_name] = field_value;
          break;
        case 'sensors':
        case 'switches':
        case 'environment':
        case 'webcams':
        case 'doors':
          if ((matches = re.exec(field_name)) !== null) {
            if (matches.index === re.lastIndex) {
              re.lastIndex++;
            }
            var current_nr = -1;
            if (matches.length >= 3) {
              if (matches[2] === undefined) {
                current_nr = matches[1];
              } else {
                current_nr = matches[2].substr(1) * 1;
              }
              if (prev_nr != current_nr) {
                if (Object.keys(objectdata).length > 1) {
                  if (form_type === 'weather' || form_type === 'environment' || form_type === 'system') {
                    formdata[prev_nr] = $.extend(true, {}, objectdata);
                  } else {
                    formdata.push($.extend(true, {}, objectdata));
                  }
                }
                // New item
                objectdata = {};
                prev_nr = current_nr;
              }
              if (matches[3] === 'on' || matches[3] === 'off') {
                field_value = moment(field_value, 'LT').unix();
              }
              objectdata[matches[3]] = field_value;
            }
          }
          break;
      }
    });
    if (Object.keys(objectdata).length > 1) {
      if (form_type === 'weather' || form_type === 'environment' || form_type === 'system') {
        formdata[prev_nr] = $.extend(true, {}, objectdata);
      } else {
        formdata.push($.extend(true, {}, objectdata));
      }
    }
  } catch (error) {
    console.log(error);
    return false;
  }
  return formdata;
}

function update_dashboard_tile(tile, text) {
  var div = $('div.tile_count #' + tile + ' div.count');
  if (div.length == 1 && div.text() != text) {
    div.text(text);
    var oldColor = div.css('color');
    div.addClass('green');
    div.animate({
      color: oldColor
    }, 1000, function() {
      $(this).removeClass('green').css('color', '');
    });
  }
}

function update_dashboard_uptime(data) {
  update_dashboard_tile('uptime', format_uptime(data.uptime));
  $('#system_time span').text(moment(data.timestamp * 1000).format('LLLL'));
  $('#system_time i').removeClass('fa-clock-o fa-sun-o fa-moon-o').addClass((data.day ? 'fa-sun-o' : 'fa-moon-o'));
  $("#uptime .progress-bar-success").css('height', (data.load[0] * 100) + '%');
  $("#uptime .progress-bar-warning").css('height', (data.load[1] * 100) + '%');
  $("#uptime .progress-bar-danger").css('height', (data.load[2] * 100) + '%');
}

function update_dashboard_power_usage(data) {
  update_dashboard_tile('power_wattage', data.current + '/' + data.max);
  var percentage = (data.max > 0 ? (data.current / data.max) * 100 : 0);
  $("#power_wattage .progress-bar-success").css('height', percentage + '%');
  data.total /= 1000;
  $("#total_power .count_bottom .costs span").text((data.price * data.total).toFixed(3));
  $("#total_power .count_bottom span.duration").text(moment.duration(data.duration * 1000).humanize());
  update_dashboard_tile('total_power', data.total.toFixed(2));
}

function update_dashboard_water_flow(data) {
  update_dashboard_tile('water_flow', data.current + '/' + data.max);
  var percentage = (data.max > 0 ? (data.current / data.max) * 100 : 0);
  $("#water_flow .progress-bar-info").css('height', percentage + '%');
  $("#total_water .count_bottom .costs span").text((data.price * (data.total / 1000)).toFixed(3));
  $("#total_water .count_bottom span.duration").text(moment.duration(data.duration * 1000).humanize());
  update_dashboard_tile('total_water', data.total.toFixed(2));
}

function update_weather(data) {
  var icons = new Skycons({
    "color": "#73879C"
  });
  var weather_current = $('div#weather_today');
  if (weather_current.length == 1) {
    weather_current.find('.status').html(moment(data.hour_forecast[0].from * 1000).format('[<b>]dddd[</b>,] LT') + ' <span> in <b>°' + globals.temperature_indicator + '</b></span>');
    weather_current.find('h2').html(data.city.city + '<br><i>' + data.hour_forecast[0].weather + '</i>');
    weather_current.find('.sunrise').text(moment(data.sun.rise * 1000).format('LT')).parent().css('fontWeight', (data.day ? 'bold' : 'normal'));
    weather_current.find('.sunset').text(moment(data.sun.set * 1000).format('LT')).parent().css('fontWeight', (data.day ? 'normal' : 'bold'));
    weather_current.find('.degrees').text(data.hour_forecast[0].temperature);
    icons.set(weather_current.find('canvas').attr('id'), data.hour_forecast[0].icon);
    var week_forecast_divs = weather_current.find('div.row.weather-days div.daily-weather');
    // Set timestamp to tomorrow at 13 hours. That is the first week forecast we take
    var timestamp = Math.round(new Date(Date.now()).setHours(13) / 1000) + (24 * 60 * 60);
    var day_counter = 0;
    var graphdata = [];
    $.each(data.week_forecast, function(index, value) {
      graphdata.push([(value.to - ((value.to - value.from) / 2)) * 1000, value.temperature]);
      if (value.from - timestamp >= 3600 && day_counter < week_forecast_divs.length) {
        $(week_forecast_divs[day_counter]).find('.day').text(moment(value.from * 1000).format('ddd'));
        $(week_forecast_divs[day_counter]).find('.degrees').text(value.temperature.toFixed(1));
        $(week_forecast_divs[day_counter]).find('h5').html(value.wind_speed.toFixed(1) + ' <i>' + (data.windspeed === 'ms' ? '{{_('m/s')}}' : '{{_('Km/h')}}') + '</i>');
        $(week_forecast_divs[day_counter]).find('canvas').attr('title',value.weather);
        icons.set($(week_forecast_divs[day_counter]).find('canvas').attr('id'), value.icon);
        day_counter++;
        timestamp += (24 * 60 * 60);
      }
    });
    icons.play();
    history_graph('weather_week', graphdata, 'weather');
    graphdata = [];
    $.each(data.hour_forecast, function(index, value) {
      graphdata.push([(value.to - ((value.to - value.from) / 2)) * 1000, value.temperature]);
    });
    history_graph('weather_day', graphdata, 'weather');
  }
}

function update_dashboard_environment(name, value) {
  var systempart = $('div.environment_' + name);
  if (systempart.length === 0 || Object.keys(value).length === 0 || !value.enabled) {
    systempart.find('table.tile_info').hide();
    return;
  }
  var enabledColor = '';
  var indicator = '°' + globals.temperature_indicator;
  switch (name) {
    case 'light':
      enabledColor = 'orange';
      break;
    case 'sprayer':
      enabledColor = 'blue';
      indicator = '%';
      break;
    case 'heater':
      enabledColor = 'red';
      break;
    case 'cooler':
      enabledColor = 'blue';
      break;
  }

  systempart.find('h4').removeClass('orange blue red')
                       .addClass(value.enabled ? enabledColor : '')
                       .attr('title', value.enabled ? "{{_('Enabled')}}" : "{{_('Disabled')}}");
  systempart.find('h4 small span').text(value.mode);

  if (value.on !== undefined) {
    systempart.find('.on').text(moment(value.on * 1000).format('LT'));
  }
  if (value.off !== undefined) {
    systempart.find('.off').text(moment(value.off * 1000).format('LT'));
    systempart.find('.duration').text(moment.duration(Math.abs(value.off - value.on) * 1000).humanize());
  }
  if (value.current !== undefined) {
    systempart.find('.current').text(value.current.toFixed(3) + ' ' + indicator);
  }
  if (value.alarm_min !== undefined) {
    systempart.find('.alarm_min').text(value.alarm_min.toFixed(3) + ' ' + indicator);
  }
  if (value.alarm_max !== undefined) {
    systempart.find('.alarm_max').text(value.alarm_max.toFixed(3) + ' ' + indicator);
  }
  if (value.alarm !== undefined) {
    systempart.find('span.glyphicon-warning-sign').toggle(value.alarm);
  }
  systempart.find('.state i').removeClass('red green').addClass(value.state === 'on' ? 'green' : 'red').attr('title', value.state === 'on' ? '{{_('On')}}' : '{{_('Off')}}');
  systempart.find('table.tile_info').show();
  setContentHeight();
}

function format_uptime(uptime) {
  uptime = moment.duration(uptime * 1000);
  var uptime_duration = '';
  uptime_duration += uptime.days() + 'D';
  uptime_duration += (uptime.hours() < 10 ? '0' : '') + uptime.hours() + 'H';
  uptime_duration += (uptime.minutes() < 10 ? '0' : '') + uptime.minutes() + 'M';
  uptime_duration += (uptime.seconds() < 10 ? '0' : '') + uptime.seconds() + 'S';
  return uptime_duration;
}

function online_updater() {
  clearTimeout(globals.online_timer);
  is_online();

  globals.online_timer = setTimeout(function() {
    is_offline();
  }, 120 * 1000);
}

function update_door_messages(online,date) {
  var title   = (online ? '{{_('Open')}}' : '{{_('Close')}}');
  var message = (online ? '{{_('Door is open')}}' : '{{_('Door is closed')}}');
  var icon    = (online ? 'fa-unlock' : 'fa-lock');
  var color   = (online ? 'red' : 'green');
  add_notification_message('door_messages', title, message, icon, color, date);
}

function update_online_messages(online) {
  var title   = (online ? '{{_('Online')}}' : '{{_('Offline')}}');
  var message = (online ? '{{_('Connection restored')}}' : '{{_('Connection lost')}}');
  var icon    = (online ? 'fa-check-circle-o' : 'fa-exclamation-triangle');
  var color   = (online ? 'green' : 'red');
  add_notification_message('online_messages', title, message, icon, color);
}

function add_notification_message(type, title, message, icon, color, date) {
  var notification_date = new Date().getTime();
  if (date != undefined) {
    notification_date = date;
  }
  var menu = $('ul#' + type);
  if (menu.find('li:first a span.message').text() == message) {
    // Skip duplicate messages
    return;
  }
  var notification = $('<a>').on('click', function() {
    close_notification_message(this);
  });
  notification.append($('<span>').addClass('image').append($('<img>').attr({
    'src': $('div.profile_pic img').attr('src'),
    'alt': '{{_('Profile image')}}'
  })));
  notification.append($('<span>').append($('<span>').text(title)).append($('<span>').addClass('time notification_timestamp').attr('data-timestamp',notification_date).text('...')));
  notification.append($('<span>').addClass('message').text(message).append($('<span>').addClass('pull-right').html('<i class="fa ' + icon + ' ' + color + '"></i>')));
  // Remove no messages line
  menu.find('li.no_message').hide();
  // Add new message on top
  menu.prepend($('<li>').addClass('notification').append(notification));
  // Only allow 6 messages, more will be removed
  menu.find('li.notification:gt(5)').remove();
  // Update the notifcation time
  notification_timestamps();
}

function close_notification_message(notification) {
  notification = $(notification).parent();
  var menu = notification.parent('ul');
  notification.remove();
  if (menu.find('li.notification').length === 0) {
    menu.find('li.no_message').show();
  } else {
    menu.find('li.no_message').hide();
  }
}

function notification_timestamps() {
  var now = (new Date()).getTime();
  $('span.notification_timestamp').each(function() {
    var timestamp = $(this).attr('data-timestamp') * 1;
    var duration = moment.duration((now - timestamp) * -1);
    $(this).text(duration.humanize(true));
  });
}

function is_online() {
  var online_indicator = $('a#online_indicator');
  online_indicator.find('span').text('{{_('Online')}}');
  online_indicator.find('i.fa').removeClass('fa-check-circle-o fa-exclamation-triangle red green').addClass('fa-check-circle-o green');
  update_online_messages(true);
}

function is_offline() {
  var online_indicator = $('a#online_indicator');
  online_indicator.find('span').text('{{_('Offline')}}');
  online_indicator.find('i.fa').removeClass('fa-check-circle-o fa-exclamation-triangle red green').addClass('fa-exclamation-triangle red');
  update_online_messages(false);
}

function update_door_indicator(status) {
  if (status == 'open') {
    door_open();
  } else {
    door_closed();
  }
}

function door_open() {
  var online_indicator = $('a#door_indicator');
  online_indicator.find('span').text('{{_('Door is open')}}');
  online_indicator.find('i.fa').removeClass('fa-lock fa-unlock red green').addClass('fa-unlock red');
  update_door_messages(true);
}

function door_closed() {
  var online_indicator = $('a#door_indicator');
  online_indicator.find('span').text('{{_('Door is closed')}}');
  online_indicator.find('i.fa').removeClass('fa-lock fa-unlock red green').addClass('fa-lock green');
  update_door_messages(false);
}

function get_theme_color(color) {
  if (color == 'orange') return '#f0ad4e';
  return $('<div>').addClass(color).css('color');
}

var CURRENT_URL = window.location.href.split('#')[0].split('?')[0],
    $BODY = $('body'),
    $MENU_TOGGLE = $('#menu_toggle'),
    $SIDEBAR_MENU = $('#sidebar-menu'),
    $SIDEBAR_FOOTER = $('.sidebar-footer'),
    $LEFT_COL = $('.left_col'),
    $RIGHT_COL = $('.right_col'),
    $NAV_MENU = $('.nav_menu'),
    $FOOTER = $('footer');

// TODO: This is some kind of easy fix, maybe we can improve this
function setContentHeight() {
  // reset height
  $RIGHT_COL.css('min-height', $(window).height());

  var bodyHeight = $BODY.outerHeight(),
    footerHeight = $BODY.hasClass('footer_fixed') ? -10 : $FOOTER.height(),
    leftColHeight = $LEFT_COL.eq(1).height() + $SIDEBAR_FOOTER.height(),
    contentHeight = bodyHeight < leftColHeight ? leftColHeight : bodyHeight;

  // normalize content
  contentHeight -= $NAV_MENU.height() + footerHeight;

  $RIGHT_COL.css('min-height', contentHeight - 15);
};

// Sidebar
function init_sidebar() {
  $SIDEBAR_MENU.find('a').on('click', function(ev) {
        var $li = $(this).parent();

        if ($li.is('.active')) {
            $li.removeClass('active active-sm');
            $('ul:first', $li).slideUp(function() {
                setContentHeight();
            });
        } else {
            // prevent closing menu if we are on child menu
            if (!$li.parent().is('.child_menu')) {
                $SIDEBAR_MENU.find('li').removeClass('active active-sm');
                $SIDEBAR_MENU.find('li ul').slideUp();
            }else
            {
        if ( $BODY.is( ".nav-sm" ) )
        {
          $SIDEBAR_MENU.find( "li" ).removeClass( "active active-sm" );
          $SIDEBAR_MENU.find( "li ul" ).slideUp();
        }
      }
            $li.addClass('active');

            $('ul:first', $li).slideDown(function() {
                setContentHeight();
            });
        }
    });

  // toggle small or large menu
  $MENU_TOGGLE.on('click', function() {
      if ($BODY.hasClass('nav-md')) {
        $SIDEBAR_MENU.find('li.active ul').hide();
        $SIDEBAR_MENU.find('li.active').addClass('active-sm').removeClass('active');
      } else {
        $SIDEBAR_MENU.find('li.active-sm ul').show();
        $SIDEBAR_MENU.find('li.active-sm').addClass('active').removeClass('active-sm');
      }

    $BODY.toggleClass('nav-md nav-sm');

    setContentHeight();

    $('.dataTable').each ( function () { $(this).dataTable().fnDraw(); });
  });

	// check active menu
	$SIDEBAR_MENU.find('a[href="' + CURRENT_URL + '"]').parent('li').addClass('current-page');

	$SIDEBAR_MENU.find('a').filter(function () {
		return this.href == CURRENT_URL;
	}).parent('li').addClass('current-page').parents('ul').slideDown(function() {
		setContentHeight();
	}).parent().addClass('active');

	// recompute content when resizing
	$(window).smartresize(function(){
		setContentHeight();
	});

	setContentHeight();

	// fixed sidebar
	if ($.fn.mCustomScrollbar) {
		$('.menu_fixed').mCustomScrollbar({
			autoHideScrollbar: true,
			theme: 'minimal',
			mouseWheel:{ preventDefault: true }
		});
	}
};
// /Sidebar

function reload_reload_theme() {
  // Panel toolbox
  $('.collapse-link').off('click').on('click', function() {
    var $BOX_PANEL = $(this).closest('.x_panel'),
        $ICON = $(this).find('i'),
        $BOX_CONTENT = $BOX_PANEL.find('.x_content');

    // fix for some div with hardcoded fix class
    if ($BOX_PANEL.attr('style')) {
        $BOX_CONTENT.slideToggle(200, function(){
            $BOX_PANEL.removeAttr('style');
            setContentHeight();
        });
    } else {
        $BOX_CONTENT.slideToggle(200, function() {
          setContentHeight();
        });
        $BOX_PANEL.css('height', 'auto');
    }

    $ICON.toggleClass('fa-chevron-up fa-chevron-down');
  });

  $('.close-link').off('click').click(function () {
    var $BOX_PANEL = $(this).closest('.x_panel');

    $BOX_PANEL.remove();
    setContentHeight();
  });
  // Tooltip
  $('[data-toggle="tooltip"]').tooltip({
    container: 'body',
    html: true
  });
  setContentHeight();
}

function sensor_gauge(name, data) {
  if ($('#' + name + ' .gauge').length == 1) {
    // Update title
    if (data.type !== undefined && data.name !== undefined) {
      $('#' + name + ' span.title').text(data.type + ' {{_('sensor')}}: ' + (data.name !== '' ? data.name : data.address));
    }
    // Update timestamp indicator
    $('#' + name + ' small').text(moment().format('LLL'));
    // Setup a new gauge if needed
    if ($('#' + name + ' .gauge').attr('done') === undefined) {
      var total_area = data.limit_max - data.limit_min;
      var colors = [
        [0.00, '#E74C3C'],
        [(data.alarm_min - data.limit_min) / total_area, '#F0AD4E'],
        [(((data.alarm_min + data.alarm_max)/2) - data.limit_min) / total_area, '#1ABB9C'],
        [(data.alarm_max - data.limit_min) / total_area, '#F0AD4E'],
        [1.00, '#E74C3C']
      ];

      var opts = {
        angle: 0,
        lineWidth: 0.6,
        pointer: {
          length: 0.80,
          strokeWidth: 0.070,
          color: '#1D212A'
        },
        limitMax: false,
        limitMin: true,
        strokeColor: '#F0F3F3',
        generateGradient: true,
        highDpiSupport: true,
        percentColors: colors,
      };
      // Init Gauge
      $('#' + name + ' .gauge').attr('done',1);
      //$('#' + name + ' .goal-wrapper span:nth-child(2)').text('°' + globals.temperature_indicator);
      globals.gauges[name] = new Gauge($('#' + name + ' .gauge')[0]).setOptions(opts);
      globals.gauges[name].setTextField($('#' + name + ' .gauge-value')[0]);
      // Only set min and max only once. Else the gauge will flicker each data update
      globals.gauges[name].maxValue = data.limit_max;
      globals.gauges[name].setMinValue(data.limit_min);
    }
    // Update values
    globals.gauges[name].set(data.current);
    $('div#' + name + ' .x_title h2 .badge').toggle(data.alarm);
  }
}

function load_history_graph(id,type,data_url,nocache) {
  if ($('#' + id + ' .history_graph').length === 1) {
    var now = + new Date();
    var data = [];
    if (type === undefined) {
      type = 'temperature';
    }
    if (nocache === undefined) {
      nocache = 0;
    }
    if (globals.graphs[id] === undefined) {
      globals.graphs[id] = {'timestamp' : 0,
                            'type' : type,
                            'data' : [],
                            'timer': null };
    }

    if ($('#' + id + ' .history_graph.loading').length === 1) {
    // Create period menu items
      var menu_items = $('#' + id + ' ul.dropdown-menu.period a');
      $.each(['day','week','month','year'],function(index,value){
        if (index === 0) {
          $(menu_items[index]).parent().addClass('focus');
        }
        $(menu_items[index]).off('click');
        $(menu_items[index]).on('click', function(){
          $(this).parent().siblings().removeClass('focus');
          $(this).parent().addClass('focus');
          load_history_graph(id,type,data_url + '/' + value ,1);
        });
      });
    }
    if (nocache === 0 && now - globals.graphs[id].timestamp < globals.graph_cache * 1000) {
      history_graph(id, globals.graphs[id].data, type);
      clearTimeout(globals.graphs[id].timer);
      globals.graphs[id].timer = setTimeout(function() {
          load_history_graph(id,type,data_url);
      }, 1 * 60 * 1000);

    } else {
      // Load fresh data...
      $.getJSON(data_url, function(online_data) {
        $.each(online_data, function(dummy, value) {
          $.each(value, function(dummy, data_array) {
            globals.graphs[id].timestamp = now;
            if (type == 'switch') {
              globals.graphs[id].data = process_switch_data(data_array);
            } else if (type == 'door') {
              globals.graphs[id].data = process_door_data(data_array);
            } else {
              globals.graphs[id].data = data_array;
            }
          });
        });

        history_graph(id, globals.graphs[id].data, type);
        clearTimeout(globals.graphs[id].timer);
        globals.graphs[id].timer = setTimeout(function() {
          load_history_graph(id,type,data_url);
        }, 1 * 60 * 1000);

      });
    }

  }
  return false;
}

function history_graph(name, data, type) {
  if (type === undefined) {
    type = 'temperature';
  }

  var graph_data = [];
  var graph_options = {
    tootip: true,
    series: {
      curvedLines: {
        apply: true,
        active: true,
        monotonicFit: true,
      },
      shadowSize: 2
    },
    grid: {
      verticalLines: true,
      hoverable: true,
      clickable: false,
      tickColor: "#d5d5d5",
      borderWidth: 1,
      color: '#fff'
    },
    colors: ["rgba(38, 185, 154, 0.38)", "rgba(3, 88, 106, 0.38)", "rgba(3, 88, 106, 0.38)"],
    xaxis: {
      tickColor: "rgba(51, 51, 51, 0.06)",
      mode: "time",
      timezone: "browser",
      tickSize: [60, "minute"],
      //tickLength: 10,
      axisLabel: "Date",
      axisLabelUseCanvas: true,
      axisLabelFontSizePixels: 12,
      axisLabelFontFamily: 'Verdana, Arial',
      axisLabelPadding: 0,
      //transform: function (v) { return -v; },
      //inverseTransform: function (v) { return -v; }
    },
    yaxis: {
      ticks: (type === 'door' ? [[0, '{{_('closed')}}'], [1, '{{_('open')}}']] : 8),
      tickColor: "rgba(51, 51, 51, 0.06)",
      tickDecimals: 1,
      tickFormatter: function(val, axis) {
        switch(type) {
          case 'system_memory':
              val = (val / (1024 * 1024)).toFixed(axis.tickDecimals) + ' MB';
            break;

          case 'system_uptime':
              val = moment.duration(val * 1000).humanize();
            break;

          case 'weather':
            val = val.toFixed(axis.tickDecimals) + ' °' + globals.temperature_indicator;
            break;

          case 'humidity':
            val = val.toFixed(axis.tickDecimals) + ' %';
            break;

          case 'switch':
            val = val.toFixed(axis.tickDecimals) + ' W';
            break;

          case 'door':
            val = (val ? '{{_('open')}}' : '{{_('closed')}}');
            break;

          default:
            val = val.toFixed(axis.tickDecimals) + (type.indexOf('temperature') !== -1 ? ' °' + globals.temperature_indicator : ' %');
            break;
        }
        return val;
      }
    }
  };

  switch (type) {
    case 'temperature':
    case 'humidity':
      graph_data = [{
        label: '{{_('Current')}}',
        data: data.current
      }, {
        label: '{{_('Alarm min')}}',
        data: data.alarm_min
      }, {
        label: '{{_('Alarm max')}}',
        data: data.alarm_max
      }];
      break;
    case 'weather':
    case 'system_temperature':
      graph_data = [{
        label: '{{_('Temperature')}}',
        data: data
      }];
      break;
    case 'system_uptime':
      delete(graph_options.series.curvedLines);
      graph_options.series.lines = {
        show: true,
        lineWidth: 2,
        fill: false
      };

      graph_data = [{
        label: '{{_('Uptime')}}',
        data: data
      }];

      $('div.row.uptime .x_title small').text(moment.duration(data[data.length-1][1] * 1000).humanize());
      break;
    case 'system_load':
      graph_data = [{
        label: '{{_('Load')}}',
        data: data.load1
      }, {
        label: '{{_('Load 5')}}',
        data: data.load5
      }, {
        label: '{{_('Load 15')}}',
        data: data.load15
      }];
      break;
    case 'system_memory':
      graph_data = [{
        label: '{{_('Used memory')}}',
        data: data.used
      }, {
        label: '{{_('Free memory')}}',
        data: data.free
      }, {
        label: '{{_('Total memory')}}',
        data: data.total
      }];
      break;
    case 'switch':
      delete(graph_options.series.curvedLines);
      graph_options.series.lines = {
        show: true,
        lineWidth: 2,
        fill: true
      };

      graph_data = [data.power_wattage, data.water_flow];
      graph_data = [{
        label: '{{_('Power usage in Watt')}}',
        data: data.power_wattage
      }, {
        label: '{{_('Water flow in L/m')}}',
        data: data.water_flow
      }];
      break;
    case 'door':
      delete(graph_options.series.curvedLines);
      graph_options.series.lines = {
        show: true,
        lineWidth: 2,
        fill: true
      };

      graph_data = [data.state];
      graph_data = [{
        label: '{{_('Door status')}}',
        data: data.state
      }];
      break;

  }
  if (graph_data[0].data != undefined && graph_data[0].data.length > 0) {
    var total_data_duration = (graph_data[0].data[graph_data[0].data.length - 1][0] - graph_data[0].data[0][0]) / 3600000;
    graph_options.xaxis.tickSize[0] = Math.round(total_data_duration * 2.5);
  }

  if ($('#' + name + ' .history_graph').length == 1) {
    $('#' + name + ' .history_graph').html('').removeClass('{{_('loading')}}');
    $.plot($('#' + name + ' .history_graph'), graph_data, graph_options);

    if (type == 'switch') {
      var usage = '';
      if (data.total_power_usage > 0) {
        usage = '{{_('Total power in kWh')}}: ' + Math.round(data.total_power_usage) / 1000;
      }
      if (data.total_water_usage > 0) {
        usage += (usage != '' ? ', ' : '') + '{{_('Total water in L')}}: ' + Math.round(data.total_water_usage * 100) / 100;
      }
      $('#' + name + ' .total_usage').text(usage);
    } else if (type == 'door') {
      var usage = '';
      if (data.open > 0) {
        usage = '{{_('Total open for')}}: ' + moment.duration(data.open).humanize();
      }
      $('#' + name + ' .total_usage').text(usage);
    }
    $('#' + name + ' .history_graph').bind('plothover', function (event, pos, item) {
      if (item) {
        $('#tooltip').css({top: item.pageY-5, left: item.pageX-5});
        $('#tooltip span').attr('data-original-title',moment(item.datapoint[0]).format('LLL') + '<br />' + item.series.label + ' ' + item.series.yaxis.tickFormatter(item.datapoint[1],item.series.yaxis));
      }
    });
  }
}

function check_form_data(form) {
  var fieldsok = true;
  form.find('input[required="required"][readonly!="readonly"][readonly!="hidden"]').each(function(counter,item) {
    var field = $(this);
    var empty = field.val() == '';
    if (empty) {
      field.addClass('missing-required');
    }
    fieldsok = fieldsok && !empty;
  });
  return fieldsok;
}

function add_sensor() {
  var form = $('.new-sensor-form');
  if (!check_form_data(form)) return false;

  add_sensor_row('None',
                 form.find('select[name="sensor_[nr]_hardwaretype"]').val(),
                 form.find('input[name="sensor_[nr]_address"]').val(),
                 form.find('select[name="sensor_[nr]_type"]').val(),
                 form.find('input[name="sensor_[nr]_name"]').val(),
                 form.find('input[name="sensor_[nr]_alarm_min"]').val(),
                 form.find('input[name="sensor_[nr]_alarm_max"]').val(),
                 form.find('input[name="sensor_[nr]_limit_min"]').val(),
                 form.find('input[name="sensor_[nr]_limit_max"]').val(),
                 -1);

  $('.new-sensor-form').modal('hide');
}

function add_sensor_row(id,hardwaretype,address,type,name,alarm_min,alarm_max,limit_min,limit_max,current) {
  var sensor_row = $($('.modal-body div.row.sensor').parent().clone().html().replace(/\[nr\]/g, $('form div.row.sensor').length));
  sensor_row.find('.x_title').show().find('h2 span').addClass('glyphicon glyphicon-' + (type == 'temperature' ? 'fire' : 'tint')).attr({'aria-hidden':'true','title': capitalizeFirstLetter(type + ' {{_('sensor')}}')});
  sensor_row.find('.x_title').show().find('h2 small').text(name);
  sensor_row.find('span.select2.select2-container').remove();

  sensor_row.find('input, select').each(function(counter,item){
    $(item).val(eval($(item).attr('name').replace(/sensor_[0-9]+_/g,'')))
  });
  sensor_row.find("input[name$='_address']").attr("readonly", hardwaretype == 'owfs' || hardwaretype == 'w1');
  sensor_row.insertBefore('div.row.submit').show();

  reload_reload_theme();

  sensor_row.find("select").select2({
    placeholder: '{{_('Select an option')}}',
    allowClear: false,
    minimumResultsForSearch: Infinity
  }).on('change',function() {
    if (this.name.indexOf('hardwaretype') >= 0) {
      $("input[name='" + this.name.replace('hardwaretype','address') + "']").attr("readonly", this.value == 'owfs' || this.value == 'w1');
    }
  });
}

function add_switch() {
  var form = $('.new-switch-form');
  if (!check_form_data(form)) return false;

  add_switch_row('None',
                 form.find('select[name="switch_[nr]_hardwaretype"]').val(),
                 form.find('input[name="switch_[nr]_address"]').val(),
                 form.find('input[name="switch_[nr]_name"]').val(),
                 form.find('input[name="switch_[nr]_power_wattage"]').val(),
                 form.find('input[name="switch_[nr]_water_flow"]').val());

  $('.new-switch-form').modal('hide');
}

function add_switch_row(id,hardwaretype,address,name,power_wattage,water_flow) {
  var switch_row = $($('.modal-body div.row.switch').parent().clone().html().replace(/\[nr\]/g, $('form div.row.switch').length));

  switch_row.find('div.power_switch.small').attr('id','switch_' + id);

  switch_row.find('.x_title').show().find('h2 small').text(name);
  switch_row.find('span.select2.select2-container').remove();

  switch_row.find('input, select').each(function(counter,item){
    $(item).val(eval($(item).attr('name').replace(/switch_[0-9]+_/g,'')));
  });

  switch_row.insertBefore('div.row.submit').show();
  reload_reload_theme();

  switch_row.find("select").select2({
    placeholder: '{{_('Select an option')}}',
    allowClear: false,
    minimumResultsForSearch: Infinity
  });
}

function add_door() {
  var form = $('.new-door-form');
  if (!check_form_data(form)) return false;

  add_door_row('None',
                form.find('select[name="door_[nr]_hardwaretype"]').val(),
                form.find('input[name="door_[nr]_address"]').val(),
                form.find('input[name="door_[nr]_name"]').val());

  $('.new-door-form').modal('hide');
}

function add_door_row(id,hardwaretype,address,name) {
  var door_row = $($('.modal-body div.row.door').parent().clone().html().replace(/\[nr\]/g, $('form div.row.door').length));
  door_row.find('.x_title').show().find('h2 small').text(name);
  door_row.find('span.select2.select2-container').remove();

  door_row.find('input, select').each(function(counter,item){
    $(item).val(eval($(item).attr('name').replace(/door_[0-9]+_/g,'')));
  });

  door_row.insertBefore('div.row.submit').show();
  reload_reload_theme();

  door_row.find("select").select2({
    placeholder: '{{_('Select an option')}}',
    allowClear: false,
    minimumResultsForSearch: Infinity
  });
}

function add_webcam() {
  var form = $('.new-webcam-form');
  if (!check_form_data(form)) return false;

  add_webcam_row('None',
                form.find('input[name="webcam_[nr]_location"]').val(),
                form.find('input[name="webcam_[nr]_name"]').val(),
                form.find('select[name="webcam_[nr]_rotation"]').val());

  $('.new-webcam-form').modal('hide');
}

function add_webcam_row(id,location,name,rotation,preview) {
  var webcam_row = $($('.modal-body div.row.webcam').parent().clone().html().replace(/\[nr\]/g, $('form div.row.webcam').length));
  webcam_row.find('.x_title').show().find('h2 small').text(name);
  webcam_row.find('span.select2.select2-container').remove();

  webcam_row.find('input, select').each(function(counter,item){
    $(item).val(eval($(item).attr('name').replace(/webcam_[0-9]+_/g,'')));
  });

  if (preview != undefined) {
    webcam_row.find('img').attr('src',preview);
  }

  webcam_row.insertBefore('div.row.submit').show();
  reload_reload_theme();

  webcam_row.find("select").select2({
    placeholder: '{{_('Select an option')}}',
    allowClear: false,
    minimumResultsForSearch: Infinity
  }).on('change',function(){
    webcam_row.find('img').removeClass('webcam_90 webcam_180 webcam_270 webcam_H webcam_V').addClass('webcam_' + this.value);
  });
}

function update_power_switch(id, data) {
  var power_switch = $('#switch_' + id);
  power_switch.find('h2 span.title').text('{{_('Switch')}} ' + data.name);
  power_switch.find('h2 small.data_update').text(data.power_wattage + 'W' + (data.water_flow > 0 ? ', ' + data.water_flow + 'L/m' : ''));
  power_switch.find('span.glyphicon').removeClass('blue green').addClass((data.state ? 'green' : 'blue')).attr('title','{{_('Toggle power switch')}}');
}

function toggleSwitch(id) {
  id = id.split('_')[1];
  $.getJSON('/api/switch/toggle/' + id,function(data){
  });
}

function process_graph_data(type, raw_data) {
  var graphdata = {}
  switch (type) {
    case 'door':
      graphdata.state = [];
      graphdata.open = 0;
    break;
    case 'switch':
      graphdata.power_wattage = [];
      graphdata.water_flow = [];
      graphdata.total_power_usage = 0;
      graphdata.total_water_usage = 0;
    break;
  }

  var state_change = -1;
  $.each(raw_data.state, function(counter, status) {
    // Sanitize input
    switch (type) {
      case 'door':
        status[1] = (status[1] === 'closed' ? 0 : 1)
      break;
      case 'switch':
        if (!status[1]) {
          raw_data.power_wattage[counter][1] = 0;
          raw_data.water_flow[counter][1] = 0;
        }
      break;
    }

    if (state_change != status[1]) {
      // Copy previous object to get the right status with current timestamp
      var copy = [];
      if (counter > 0) {
        $.each(graphdata, function(name,data){
          if (typeof graphdata[name] == 'object' ) {
            copy = $.extend(true, [], raw_data[name][counter-1]);
            // If turned down/off/closed, calculate usage, else it is zero!
            var usage = (copy[1] != 0 ? (status[0] - copy[0]) / 1000 * copy[1] : 0);
            switch (name) {
              case 'state':
                graphdata.open += usage;
              break;
              case 'power_wattage':
                graphdata.total_power_usage += usage;
              break;
              case 'water_flow':
                graphdata.total_water_usage += usage;
              break;
            }
            copy[0] = status[0];
            graphdata[name].push(copy);
          }
        });
      } else if (counter == 0 && status[1] == 1 && type == 'door') {
        // If starting with status up/on add a status down/off first for nice graphing
        $.each(graphdata, function(name,data){
          if (typeof graphdata[name] == 'object' ) {
            copy = $.extend(true, [], raw_data[name][counter]);
            // If turned down/off/closed, calculate usage, else it is zero!
            var usage = (copy[1] != 0 ? (status[0] - copy[0]) / 1000 * copy[1] : 0);
            switch (name) {
              case 'state':
                graphdata.open += usage;
              break;
              case 'power_wattage':
                graphdata.total_power_usage += usage;
              break;
              case 'water_flow':
                graphdata.total_water_usage += usage;
              break;
            }
            copy[1] = 0;
            graphdata[name].push(copy);
          }
        });
      }
      state_change = status[1];
    }
    $.each(graphdata, function(name,data){
      if (typeof graphdata[name] == 'object' ) {
        graphdata[name].push(raw_data[name][counter]);
      }
    });
  });
  // Add end data to now... and a startdate of 24 hours ago if needed
  var now = new Date().getTime();
  var start = now - (24 * 60 * 60 * 1000);
  $.each(graphdata, function(name,data){
    if (typeof graphdata[name] == 'object' ) {
      graphdata[name].push([now,graphdata[name][graphdata[name].length-1][1]]);
      // Add begin timestamp 24 hours back if needed
      if (graphdata[name][0][0] > start) {
        graphdata[name].unshift([start,graphdata[name][0][1]]);
      }
    }
  });
  if (type === 'switch') {
    graphdata.total_power_usage /= 3600; // To kWh
    graphdata.total_water_usage /= 60; // To liters
  }
  // Return data
  return graphdata;
}

function process_switch_data(raw_data) {
  return process_graph_data('switch', raw_data);
}

function process_door_data(raw_data) {
  return process_graph_data('door', raw_data);
}

function update_webcam_preview(name, url) {
  $('img#webcam_' + name + '_preview').attr('src', url);
}

function initWebcam(webcamid, name, maxzoom) {
  if ($('div#webcam_' + webcamid).length === 1) {
    $('div#webcam_' + webcamid).parents('.x_panel').find('h2 small').text(name);
    if (!$('div#webcam_' + webcamid).hasClass('leaflet-container')) {
      globals.webcams[webcamid] = null;
      var webcam = new L.Map('webcam_' + webcamid, {
        layers: [createWebcamLayer(webcamid, maxzoom)],
        fullscreenControl: true,
      }).setView([0, 0], 1);
      var loadingControl = L.Control.loading({
        separate: true
      });
      webcam.addControl(loadingControl);
      updateWebcam(webcam);
    }
  }
}

function updateWebcam(webcam) {
  if ($('div#' + webcam._container.id).length === 1) {
    webcam.eachLayer(function(layer) {
      layer.redraw();
    });
    clearTimeout(globals.webcams[webcam._container.id]);
    globals.webcams[webcam._container.id] = setTimeout(function() { updateWebcam(webcam);},30 * 1000);
  }
}

function createWebcamLayer(webcamid, maxzoom) {
  return L.tileLayer('/webcam/{id}_tile_{z}_{x}_{y}.jpg?_{time}', {
    time: function() {
      return (new Date()).valueOf();
    },
    id: webcamid,
    noWrap: true,
    continuousWorld: false,
    maxNativeZoom: maxzoom,
    maxZoom: maxzoom + 1
  });
}

function load_door_history() {
  $.getJSON('/api/history/doors', function(door_data) {
    var door_status = {};
    $.each(door_data.door, function(counter, statedata) {
      for (var i = 0; i < statedata.state.length; i++) {
        if (i == 0 || statedata.state[i][1] != statedata.state[i-1][1]) {
          door_status[statedata.state[i][0]] = statedata.state[i][1];
        }
      }
    });
    // Sort door data events on time. Needed if you have more than one door
    $.each(Object.keys(door_status).sort(), function(counter,change_time) {
      update_door_messages((door_status[change_time] == 'open'), change_time);
    })
  });
}

function capitalizeFirstLetter(string) {
    return string[0].toUpperCase() + string.slice(1);
}

function version_check() {
  $.getJSON('https://api.github.com/repos/theyosh/TerrariumPI/releases/latest' ,function(data){

    var latest_version = data.tag_name.replace(/\./g,'') * 1;
    var current_version = globals.current_version.replace(/\./g,'') * 1;
    if (latest_version < 100) latest_version *= 10;
    if (current_version < 100) current_version *= 10;

    if (current_version < latest_version) {
      var message = 'New version available! <a href="' + data.html_url + '" target="_blank" title="Download TerrariumPI version ' + data.tag_name + '">Click here to download</a>!';
      new PNotify({
            type: 'info',
            title: 'New release: ' + data.tag_name,
            text: message,
            delay: 1000,
            mouse_reset: false,
            styling: 'bootstrap3',
            hide: false
        });
    }

    setTimeout(function() {
      version_check();
    },   24 * 60 * 60 * 1000 ); // Check once a day
  });
}

$(document).ready(function() {
  init_sidebar();

  moment.locale($('html').attr('lang'));
  $('#system_time span').text(moment().format('LLLL'));
  websocket_init(false);
  // Bind to menu links in order to load Ajax calls
  $('#sidebar-menu a').each(function() {
    $(this).on('click', load_page).attr('title',$(this).parents('li').find('a:first').text());
  });
  // NProgress bar animation during Ajax calls
  $(document).on({
    ajaxStart: function() {
      NProgress.start();
    },
    ajaxComplete: function() {
      NProgress.done();
    }
  });

  $("<div id='tooltip'><span title='tooltip' id='tooltiptext' data-toggle='tooltip'>&nbsp;&nbsp;&nbsp;</span></div>").css({
      position: "absolute",
	}).appendTo("body");

  load_door_history();
  load_page('dashboard.html');

  setInterval(function() {
    notification_timestamps();
    $('#system_time span').text(moment().format('LLLL'));
  }, 30 * 1000);

  version_check();
});
