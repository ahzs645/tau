wallthick = 2;
floorthick = 1;
joinerytabthick =2;

catanhexdia = 93;
catanhexwelldepth = 50;

catanplayertokenwide = 85;
catanplayertokentall = 104;
catanplayertokenwelldepth = 15;

catanresourcecardwide = 56;
catanresourcecardtall = 81;
catanresourcecardwelldepth = 35;

catanborderwide = 70.5;
catanbordertall = 250;
catanborderwelldepth = 25;

catanboxinsertwide = 230;
catanboxinserttall = 285;
catanboxinsertthick = 75;

//linear_extrude(4)
//projection(cut=true)
//translate([0,0,-20])
//splitboxinsert("bl");

boxinsert();

//cardtopper();

module cardtopper(){
    cube([catanresourcecardwide-2, catanresourcecardtall-2,wallthick]);
}

module splitboxinsert(part="tl"){
    if (part == "tl"){
        intersection(){
            translate([catanboxinsertwide/4, -catanboxinserttall/4, 0])
            boxinsert();
            translate([0,0,catanboxinsertthick/2])
            cube([catanboxinsertwide/2,catanboxinserttall/2,catanboxinsertthick],center=true);
            
        }
        translate([catanboxinsertwide/4,catanboxinserttall/4-(joinerytabthick+wallthick*2)/2-0.5,0])
        tabwall("A");
        
        translate([-catanboxinsertwide/4+(joinerytabthick+wallthick*2)/2 + 0.5, -catanboxinserttall/4, 0])
        rotate(-90)
        tabwall("A");
        
    } else if (part == "tr"){
        intersection(){
            translate([-catanboxinsertwide/4, -catanboxinserttall/4, 0])
            boxinsert();
            translate([0,0,catanboxinsertthick/2])
            cube([catanboxinsertwide/2,catanboxinserttall/2,catanboxinsertthick],center=true);
        }
        translate([-catanboxinsertwide/4,catanboxinserttall/4-(joinerytabthick+wallthick*2)/2-0.5,0])
        tabwall("B");
        
        
    } else if (part == "bl"){
        intersection(){
            translate([catanboxinsertwide/4, catanboxinserttall/4, 0])
            boxinsert();
            translate([0,0,catanboxinsertthick/2])
            cube([catanboxinsertwide/2,catanboxinserttall/2,catanboxinsertthick],center=true);
            
        }
        translate([catanboxinsertwide/4,-catanboxinserttall/4+(joinerytabthick+wallthick*2)/2+0.5,0])
        tabwall("A");
        
        translate([catanboxinsertwide/4,-catanboxinserttall/4+3.5*(joinerytabthick+wallthick*2)/2+1+catanresourcecardtall,0])
        tabwall("A");
        
        translate([-catanboxinsertwide/4+(joinerytabthick+wallthick*2)/2 + 0.5, catanboxinserttall/4, 0])
        rotate(-90)
        tabwall("B");
        
        
    } else { // part == br
        intersection(){
            translate([-catanboxinsertwide/4, catanboxinserttall/4, 0])
            boxinsert();
            translate([0,0,catanboxinsertthick/2])
            cube([catanboxinsertwide/2,catanboxinserttall/2,catanboxinsertthick],center=true);
            
        }
        translate([-catanboxinsertwide/4,-catanboxinserttall/4+(joinerytabthick+wallthick*2)/2+0.5,0])
        tabwall("B");
        
        translate([-catanboxinsertwide/4,-catanboxinserttall/4+3.5*(joinerytabthick+wallthick*2)/2+1+catanresourcecardtall,0])
        tabwall("B");
        
    }
}

module boxinsert(){
    difference(){
        boxinsertsub();
        
        // finger holes for hex tiles
        translate([-catanboxinsertwide/2 + wallthick + catanhexdia/2, -catanboxinserttall/2 + wallthick + catanhexdia/2 - (catanhexdia/2-cos(30)*catanhexdia/2),catanboxinsertthick-catanhexwelldepth])
        hexfingerholes();
        translate([-catanboxinsertwide/2 + wallthick + catanhexdia/2, -catanboxinserttall/2 + wallthick*2 + catanhexdia*1.5 - 3*(catanhexdia/2-cos(30)*catanhexdia/2),catanboxinsertthick-catanhexwelldepth])
        hexfingerholes();
        
        translate([catanhexdia/2-cos(45)*(catanhexdia/2-2), -sin(45)*(catanhexdia/2-2), catanboxinsertthick - catanborderwelldepth])
        fingerhole();
        
        // finger holes for the cards
        translate([catanboxinsertwide/2-wallthick*2.5-catanborderwide-catanresourcecardwide, -catanboxinserttall/2+wallthick*2+joinerytabthick+catanresourcecardtall-10, catanboxinsertthick-catanresourcecardwelldepth])
        fingerhole();
        hull(){
            translate([catanboxinsertwide/2-wallthick*1.5-catanborderwide, -catanboxinserttall/2+wallthick*2+joinerytabthick+12.5, catanboxinsertthick-catanresourcecardwelldepth])
            fingerhole();
            translate([catanboxinsertwide/2-wallthick*1.5-catanborderwide+20, -catanboxinserttall/2+wallthick*2+joinerytabthick+12.5, catanboxinsertthick-catanresourcecardwelldepth+15])
            fingerhole();
        }
        
        // one semi redundant one for the player tokens
        translate([-catanboxinsertwide/2+wallthick+12, catanboxinserttall/2-wallthick*1.5-catanplayertokentall, catanboxinsertthick-catanplayertokenwelldepth*2])
        fingerhole();
        
    }
}

module hexfingerholes(){
    angle = 38;
    radius = (catanhexdia/2-5);
    translate([cos(angle)*radius, sin(angle)*radius, 0])
    fingerhole();
    translate([-cos(angle)*radius, -sin(angle)*radius, 0])
    fingerhole();
}

module fingerhole(){
    hull(){
        sphere(d=20);
        translate([0,0,catanboxinsertthick])
        sphere(d=20);
    }
}


module boxinsertsub(){
    difference(){
        boxinsertmain();
        
        translate([0,0,floorthick])
        linear_extrude(catanboxinsertthick+10)
        offset(-wallthick)
        projection(cut=true)
        translate([0,0,-catanboxinsertthick+5])
        boxinsertmain();
        
    }
    wall([[-catanboxinsertwide/2+wallthick*1.5+catanhexdia,-catanboxinserttall/2 + wallthick + catanhexdia/2 - (catanhexdia/2-cos(30)*catanhexdia/2),catanboxinsertthick],[catanboxinsertwide/2-wallthick*2.5-catanresourcecardwide-catanborderwide,-catanboxinserttall/2 + wallthick + catanhexdia/2 - (catanhexdia/2-cos(30)*catanhexdia/2),catanboxinsertthick]],r=wallthick/2,fn=8);
    
    wall([
    [-catanboxinsertwide/2 + wallthick + catanhexdia/2 + sin(30)*(catanhexdia/2+wallthick/2), -catanboxinserttall/2 + wallthick*2 + catanhexdia*1.5 - 3*(catanhexdia/2-cos(30)*catanhexdia/2) + cos(30)*(catanhexdia/2+wallthick/2), catanboxinsertthick],
    [-catanboxinsertwide/2+wallthick*1.5+catanplayertokenwide, catanboxinserttall/2 - wallthick*1.5 - catanplayertokentall, catanboxinsertthick],
    [catanboxinsertwide/2 - wallthick - catanborderwide-cos(30)*(catanhexdia/2+wallthick/2), 0 + sin(30)*(catanhexdia/2+wallthick/2),catanboxinsertthick]
    ],r=wallthick/2,fn=8);
}




module boxinsertmain(){
    
    difference(){
        // giant cube
        translate([0,0,catanboxinsertthick/2])
        cube([catanboxinsertwide, catanboxinserttall, catanboxinsertthick],center=true);
        
        // cut out the two hexes
        translate([-catanboxinsertwide/2 + wallthick + catanhexdia/2, -catanboxinserttall/2 + wallthick + catanhexdia/2 - (catanhexdia/2-cos(30)*catanhexdia/2),-5])
        cylinder(d = catanhexdia, h = catanboxinsertthick+10, $fn = 6);
        
        translate([-catanboxinsertwide/2 + wallthick + catanhexdia/2, -catanboxinserttall/2 + wallthick*2 + catanhexdia*1.5 - 3*(catanhexdia/2-cos(30)*catanhexdia/2), -5])
        cylinder(d = catanhexdia, h = catanboxinsertthick+10, $fn = 6);
        
        // cut out the player token insert
        translate([-catanboxinsertwide/2 + wallthick + catanplayertokenwide/2, catanboxinserttall/2-wallthick - catanplayertokentall/2, catanboxinsertthick/2])
        cube([catanplayertokenwide, catanplayertokentall, catanboxinsertthick+10],center=true);
        
        // cut out the border frame insert
        translate([catanboxinsertwide/2 - wallthick - catanborderwide/2,- catanboxinserttall/2 + wallthick + catanbordertall/2, catanboxinsertthick/2])
        cube([catanborderwide, catanbordertall, catanboxinsertthick+10], center=true);
        
        // cut out space for the cards
        translate([catanboxinsertwide/2 - wallthick*2 - catanborderwide - catanresourcecardwide/2, -catanboxinserttall/2+wallthick+catanresourcecardtall/2 + joinerytabthick+wallthick*2, catanboxinsertthick/2])
        cube([catanresourcecardwide, catanresourcecardtall, catanboxinsertthick+10], center=true);
        
        // cut out a hex for the wierd border tile from the seafarers expansion
        translate([catanboxinsertwide/2 - wallthick - catanborderwide,0, -5])
        rotate(90)
        cylinder(d=catanhexdia, h = catanboxinsertthick+10, $fn=6);
        
    }
    
    // hexes - solid floor
    translate([-catanboxinsertwide/2 + wallthick + catanhexdia/2, -catanboxinserttall/2 + wallthick + catanhexdia/2 - (catanhexdia/2-cos(30)*catanhexdia/2),0])
    hexstackinsert();
    
    translate([-catanboxinsertwide/2 + wallthick + catanhexdia/2, -catanboxinserttall/2 + wallthick*2 + catanhexdia*1.5 - 3*(catanhexdia/2-cos(30)*catanhexdia/2), 0])
    hexstackinsert();
    
    // player tokens - solid floor
    translate([-catanboxinsertwide/2 + wallthick + catanplayertokenwide/2, catanboxinserttall/2-wallthick - catanplayertokentall/2, 0])
    playertokeninsert();
    
    // cards - solid floor
    translate([catanboxinsertwide/2 - wallthick*2 - catanborderwide - catanresourcecardwide/2, -catanboxinserttall/2+wallthick+catanresourcecardtall/2 + joinerytabthick+wallthick*2, 0])
    cardsinsert();
    
    // border frame insert - solid floor
    translate([catanboxinsertwide/2 - wallthick - catanborderwide/2,- catanboxinserttall/2 + wallthick + catanbordertall/2, 0])
    borderinsert();
    
    
}

// CHANGED: solid hex floor instead of cross-bar lattice
module hexstackinsert(){
    tall = (catanboxinsertthick - catanhexwelldepth);
    cylinder(d = catanhexdia+0.5, h = tall, $fn = 6);
}

// CHANGED: solid rectangular floor instead of grid lattice
module playertokeninsert(){
    tall = catanboxinsertthick - catanplayertokenwelldepth;
    translate([0,0,tall/2])
    cube([catanplayertokenwide+0.5, catanplayertokentall+0.5, tall], center=true);
}

// CHANGED: solid rectangular floor instead of cross bars
module cardsinsert(){
    tall = catanboxinsertthick - catanresourcecardwelldepth;
    translate([0,0,tall/2])
    cube([catanresourcecardwide+0.5, catanresourcecardtall+0.5, tall], center=true);
}

// CHANGED: solid floors instead of grid lattice with curved top cutout
module borderinsert(){
    tall = (catanboxinsertthick - catanborderwelldepth);
    centeryoffset = (catanboxinserttall-wallthick*2 - catanbordertall)/2;
    
    // solid hex floor for the seafarers hex area
    translate([-catanborderwide/2, centeryoffset, 0])
    intersection(){
        rotate(30)
        cylinder(d = catanhexdia+0.5, h = tall, $fn = 6);
        translate([-catanhexdia/2, 0, tall/2])
        cube([catanhexdia, catanhexdia*2, tall], center=true);
    }
    translate([-catanborderwide/2-wallthick/2, centeryoffset, tall/2])
    cube([wallthick, catanhexdia+1, tall], center=true);
    
    // solid rectangular floor for border pieces
    translate([0,0,tall/2])
    cube([catanborderwide+0.5, catanbordertall+0.5, tall], center=true);
}


module boxinsertplain(){
    difference(){
        boxinsertmainplain();
        
        translate([0,0,floorthick])
        linear_extrude(catanboxinsertthick+10)
        offset(-wallthick)
        projection(cut=true)
        translate([0,0,-catanboxinsertthick/2])
        boxinsertmainplain();
        
    }
    wall([[-catanboxinsertwide/2+wallthick*1.5+catanhexdia,-catanboxinserttall/2 + wallthick + catanhexdia/2 - (catanhexdia/2-cos(30)*catanhexdia/2),catanboxinsertthick],[catanboxinsertwide/2-wallthick*2.5-catanresourcecardwide-catanborderwide,-catanboxinserttall/2 + wallthick + catanhexdia/2 - (catanhexdia/2-cos(30)*catanhexdia/2),catanboxinsertthick]],r=wallthick/2,fn=8);
    
    wall([
    [-catanboxinsertwide/2 + wallthick + catanhexdia/2 + sin(30)*(catanhexdia/2+wallthick/2), -catanboxinserttall/2 + wallthick*2 + catanhexdia*1.5 - 3*(catanhexdia/2-cos(30)*catanhexdia/2) + cos(30)*(catanhexdia/2+wallthick/2), catanboxinsertthick],
    [-catanboxinsertwide/2+wallthick*1.5+catanplayertokenwide, catanboxinserttall/2 - wallthick*1.5 - catanplayertokentall, catanboxinsertthick],
    [catanboxinsertwide/2 - wallthick - catanborderwide-cos(30)*(catanhexdia/2+wallthick/2), - catanboxinserttall/2 + wallthick*2 + catanresourcecardtall+catanhexdia/2+ 1*(joinerytabthick+wallthick*2) + sin(30)*(catanhexdia/2+wallthick/2),catanboxinsertthick]
    ],r=wallthick/2,fn=8);
}


module boxinsertmainplain(){
    
    difference(){
        // giant cube
        translate([0,0,catanboxinsertthick/2])
        cube([catanboxinsertwide, catanboxinserttall, catanboxinsertthick],center=true);
        
        // cut out the two hexes
        translate([-catanboxinsertwide/2 + wallthick + catanhexdia/2, -catanboxinserttall/2 + wallthick + catanhexdia/2 - (catanhexdia/2-cos(30)*catanhexdia/2), floorthick])
        cylinder(d = catanhexdia, h = catanboxinsertthick, $fn = 6);
        
        translate([-catanboxinsertwide/2 + wallthick + catanhexdia/2, -catanboxinserttall/2 + wallthick*2 + catanhexdia*1.5 - 3*(catanhexdia/2-cos(30)*catanhexdia/2), floorthick])
        cylinder(d = catanhexdia, h = catanboxinsertthick, $fn = 6);
        
        // cut out the player token insert
        translate([-catanboxinsertwide/2 + wallthick + catanplayertokenwide/2, catanboxinserttall/2-wallthick - catanplayertokentall/2, floorthick+catanboxinsertthick/2])
        cube([catanplayertokenwide, catanplayertokentall, catanboxinsertthick],center=true);
        
        // cut out the border frame insert
        translate([catanboxinsertwide/2 - wallthick - catanborderwide/2,- catanboxinserttall/2 + wallthick + catanbordertall/2, floorthick+catanboxinsertthick/2])
        cube([catanborderwide, catanbordertall, catanboxinsertthick], center=true);
        
        // cut out space for the cards
        translate([catanboxinsertwide/2 - wallthick*2 - catanborderwide - catanresourcecardwide/2, -catanboxinserttall/2+wallthick+catanresourcecardtall/2 + joinerytabthick+wallthick*2, floorthick + catanboxinsertthick/2])
        cube([catanresourcecardwide, catanresourcecardtall, catanboxinsertthick], center=true);
        
        // cut out a hex for the wierd border tile from the seafarers expansion
        translate([catanboxinsertwide/2 - wallthick - catanborderwide,- catanboxinserttall/2 + wallthick*2 + catanresourcecardtall+catanhexdia/2+ 1*(joinerytabthick+wallthick*2), floorthick])
        rotate(90)
        cylinder(d=catanhexdia, h = catanboxinsertthick, $fn=6);
        
    }
    
    
}



module wall(pointslist,r=1.5,center=false,fn=32){
    union(){
        for (idx = [0:1:len(pointslist)-2]){
            hull(){
                if (center==false){
                    translate([pointslist[idx][0],pointslist[idx][1],0])
                    cylinder_outer(pointslist[idx][2], r, fn);
                    translate([pointslist[idx+1][0],pointslist[idx+1][1],0])
                    cylinder_outer(pointslist[idx+1][2], r, fn);
                } else {
                    translate([pointslist[idx][0],pointslist[idx][1],0])
                    cylinder_outerc(pointslist[idx][2], r, fn);
                    translate([pointslist[idx+1][0],pointslist[idx+1][1],0])
                    cylinder_outerc(pointslist[idx+1][2], r, fn);
                }
                
            }
        }
    }
}

module cylinder_outer(height,radius,fn){
   fudge = 1/cos(180/fn);
   cylinder(h=height,r=radius*fudge,$fn=fn);}
   
module tabwall(side = "A",cut=false){
    tabdia = 15;
    if (side == "B"){
        if (cut == false){
            difference(){
                union(){
                    translate([(tabdia/2+wallthick)/2, 0, catanboxinsertthick/2])
                    cube([(tabdia/2+wallthick), joinerytabthick+wallthick*2, catanboxinsertthick], center=true);
                    
                    
                    translate([0,0,catanboxinsertthick/4])
                    rotate([90,0,0])
                    //rotate(360/12)
                    cylinder(d=tabdia,h=joinerytabthick,$fn=4,center=true);
                    
                    translate([0,0,catanboxinsertthick/4*3])
                    rotate([90,0,0])
                    //rotate(360/12)
                    cylinder(d=tabdia,h=joinerytabthick,$fn=4,center=true);
                    
                }
                translate([0,0,catanboxinsertthick/2])
                rotate([90,0,0])
                //rotate(360/8)
                cylinder(d=tabdia,h=joinerytabthick,$fn=4,center=true);
            }
        } else {
            translate([(tabdia/2+wallthick+1)/2+1, 0, catanboxinsertthick/2])
            cube([(tabdia/2+wallthick+1), joinerytabthick+wallthick*2, catanboxinsertthick], center=true);
        }
        
    } else {
        if(cut==false){
            difference(){
                union(){
                    translate([-(tabdia/2+wallthick)/2, 0, catanboxinsertthick/2])
                    cube([(tabdia/2+wallthick), joinerytabthick+wallthick*2, catanboxinsertthick], center=true);
                    
                    translate([0,0,catanboxinsertthick/2])
                    rotate([90,0,0])
                    //rotate(360/8)
                    cylinder(d=tabdia,h=joinerytabthick,$fn=4,center=true);
                    
                }
                translate([0,0,catanboxinsertthick/4])
                rotate([90,0,0])
                //rotate(360/12)
                cylinder(d=tabdia,h=joinerytabthick,$fn=4,center=true);
                
                translate([0,0,catanboxinsertthick/4*3])
                rotate([90,0,0])
                //rotate(360/12)
                cylinder(d=tabdia,h=joinerytabthick,$fn=4,center=true);
                
                
            }
        } else {
            translate([-(tabdia/2+wallthick+1)/2+1, 0, catanboxinsertthick/2])
            cube([(tabdia/2+wallthick+1), joinerytabthick+wallthick*2, catanboxinsertthick], center=true);
        }
    }
}
